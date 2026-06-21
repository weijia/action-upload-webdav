const core = require('@actions/core');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const http = require('http');
const https = require('https');

// 获取输入参数
const WEBDAV_URL = core.getInput('webdav-url');
const WEBDAV_USERNAME = core.getInput('webdav-username');
const WEBDAV_PASSWORD = core.getInput('webdav-password');
const WEBDAV_ROOT = core.getInput('webdav-root') || '';
const SOURCE_DIRECTORY = core.getInput('source-directory');
const UPLOAD_DIRECTORY = core.getInput('upload-directory') || '';
const COPY_TO_LATEST = core.getInput('copy-to-latest') === 'true';
const DEBUG = core.getInput('debug') === 'true';
const KEEP_VERSIONS = parseInt(core.getInput('keep-versions') || '5', 10);

// 上传成功和失败计数
let successCount = 0;
let failureCount = 0;

// 检查配置是否完整
if (!WEBDAV_URL || !WEBDAV_USERNAME || !WEBDAV_PASSWORD) {
  core.setFailed('WebDAV configuration is incomplete. Please set webdav-url, webdav-username, and webdav-password inputs.');
  process.exit(1);
}

// 检查源目录是否存在
if (!fs.existsSync(SOURCE_DIRECTORY)) {
  core.setFailed(`Source directory not found: ${SOURCE_DIRECTORY}`);
  process.exit(1);
}

// 获取上传目录
function getUploadDirectory() {
  // 如果用户指定了上传目录，直接使用
  if (UPLOAD_DIRECTORY) {
    core.info(`Using specified upload directory: ${UPLOAD_DIRECTORY}`);
    return UPLOAD_DIRECTORY;
  }

  try {
    // 尝试获取当前 tag
    const tag = execSync('git describe --tags --exact-match 2>/dev/null', {
      encoding: 'utf8'
    }).trim();
    if (tag) {
      core.info('Using fixed "release" directory for tagged version.');
      return 'release';
    }
  } catch (error) {
    // 没有 tag，使用时间戳
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    core.info(`No tag found, using timestamp "${timestamp}" as upload directory.`);
    return timestamp;
  }

  // 兜底：如果 git 命令失败，使用时间戳
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  core.info(`Fallback to timestamp "${timestamp}" as upload directory.`);
  return timestamp;
}

// 生成认证头
function getAuthHeader() {
  const auth = Buffer.from(`${WEBDAV_USERNAME}:${WEBDAV_PASSWORD}`).toString('base64');
  return `Basic ${auth}`;
}

// WebDAV 请求函数
function webdavRequest(method, url, body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    try {
      const parsedUrl = new URL(url);
      const options = {
        protocol: parsedUrl.protocol,
        hostname: parsedUrl.hostname,
        port: parsedUrl.port,
        path: parsedUrl.pathname,
        method,
        headers: {
          Authorization: getAuthHeader(),
          'Content-Type': 'application/octet-stream',
          ...headers
        }
      };

      if (DEBUG) {
        core.info(`[DEBUG] Request: ${method} ${url}`);
        core.info(`[DEBUG] Headers: ${JSON.stringify(options.headers, null, 2)}`);
        if (body) {
          core.info(`[DEBUG] Body length: ${body.length} bytes`);
        }
      }

      const httpModule = parsedUrl.protocol === 'https:' ? https : http;
      const req = httpModule.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          if (DEBUG) {
            core.info(`[DEBUG] Response: ${res.statusCode}`);
            core.info(`[DEBUG] Response data: ${data}`);
          }

          // 处理 301/302/307 重定向
          if ((res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307) && res.headers.location) {
            core.info(`[DEBUG] Redirecting to: ${res.headers.location}`);
            webdavRequest(method, res.headers.location, body, headers)
              .then(resolve)
              .catch(reject);
            return;
          }

          resolve({ statusCode: res.statusCode, data });
        });
      });

      req.on('error', (error) => {
        core.error(`[ERROR] Request error: ${error.message}`);
        reject(error);
      });

      if (body) {
        req.write(body);
      }

      req.end();
    } catch (error) {
      core.error(`[ERROR] Request setup error: ${error.message}`);
      reject(error);
    }
  });
}

// 创建目录
async function createDirectory(directoryUrl) {
  try {
    const fixedDirectoryUrl = fixWebDavUrl(directoryUrl);
    core.info(`Creating directory: ${fixedDirectoryUrl}`);
    const response = await webdavRequest('MKCOL', fixedDirectoryUrl);

    if (response.statusCode === 201) {
      core.info(`Directory created successfully: ${fixedDirectoryUrl}`);
      return true;
    } else if (response.statusCode === 405 || response.statusCode === 200 || response.statusCode === 301) {
      core.info(`Directory already exists: ${fixedDirectoryUrl}`);
      return true;
    } else if (response.statusCode === 409) {
      core.info(`Directory conflict (409) - may need to create parent directories first: ${fixedDirectoryUrl}`);
      const urlWithoutSlash = fixedDirectoryUrl.endsWith('/') ? fixedDirectoryUrl.slice(0, -1) : fixedDirectoryUrl;
      const parentPath = urlWithoutSlash.substring(0, urlWithoutSlash.lastIndexOf('/') + 1);
      core.info(`Parent path: ${parentPath}`);
      if (parentPath && parentPath !== fixedDirectoryUrl && parentPath !== urlWithoutSlash + '/') {
        await createDirectory(parentPath);
        const retryResponse = await webdavRequest('MKCOL', fixedDirectoryUrl);
        if (retryResponse.statusCode === 201 || retryResponse.statusCode === 405 || retryResponse.statusCode === 200) {
          core.info(`Directory created successfully after parent creation: ${fixedDirectoryUrl}`);
          return true;
        }
      }
      return false;
    } else {
      core.error(`Error creating directory ${fixedDirectoryUrl}: ${response.statusCode} - ${response.data}`);
      return false;
    }
  } catch (error) {
    core.error(`Error creating directory ${directoryUrl}: ${error.message}`);
    return false;
  }
}

// 删除目录及其所有内容
async function deleteDirectory(directoryUrl) {
  try {
    const fixedDirectoryUrl = fixWebDavUrl(directoryUrl);
    core.info(`Deleting directory: ${fixedDirectoryUrl}`);

    // 先尝试用 PROPFIND 获取目录内容，逐个删除
    const depthHeader = { Depth: '1' };
    const listResponse = await webdavRequest('PROPFIND', fixedDirectoryUrl, null, depthHeader);

    if (listResponse.statusCode === 207) {
      // 解析 XML 获取所有子资源的 URL - 兼容多种命名空间
      const hrefs = extractHrefs(listResponse.data);

      // 从最深层开始删除（倒序，排除目录本身）
      const sortedHrefs = hrefs
        .map(h => decodeURIComponent(h))
        .filter(h => h !== fixedDirectoryUrl && h !== fixedDirectoryUrl.replace(/\/$/, ''))
        .sort((a, b) => b.split('/').length - a.split('/').length);

      for (const href of sortedHrefs) {
        const fullHref = href.startsWith("http") ? href : `${WEBDAV_URL}${href.startsWith("/") ? "" : "/"}${href}`;
        const delResponse = await webdavRequest('DELETE', fullHref);
        if (delResponse.statusCode === 204 || delResponse.statusCode === 200) {
          core.info(`Deleted: ${href}`);
        } else {
          core.warning(`Failed to delete ${href}: ${delResponse.statusCode}`);
        }
      }
    }

    // 最后删除目录本身
    const deleteResponse = await webdavRequest('DELETE', fixedDirectoryUrl);
    if (deleteResponse.statusCode === 204 || deleteResponse.statusCode === 200) {
      core.info(`Directory deleted successfully: ${fixedDirectoryUrl}`);
      return true;
    } else {
      core.warning(`Failed to delete directory ${fixedDirectoryUrl}: ${deleteResponse.statusCode} - ${deleteResponse.data}`);
      // 某些服务器可能已经不存在，视为成功
      return true;
    }
  } catch (error) {
    core.error(`Error deleting directory: ${error.message}`);
    return false;
  }
}

// ========== XML 解析辅助函数 ==========

/**
 * 从 WebDAV PROPFIND 响应中提取所有 href
 * 兼容多种 XML 命名空间格式：
 *   <d:href>...</d:href>
 *   <D:href>...</D:href>
 *   <href>...</href>
 *   以及带 XML 命名空间声明的各种变体
 */
function extractHrefs(xmlData) {
  const hrefs = [];
  // 匹配任意命名空间前缀的 href 标签
  const hrefRegex = /<(?:\w+:)?href\s*>([^<]+)<\/(?:\w+:)?href\s*>/gi;
  let match;
  while ((match = hrefRegex.exec(xmlData)) !== null) {
    hrefs.push(match[1].trim());
  }
  return hrefs;
}

/**
 * 从单个 WebDAV response 块中提取指定属性值
 * 兼容多种 XML 命名空间格式
 */
function extractPropValue(responseContent, propName) {
  // 匹配任意命名空间前缀的属性标签
  const regex = new RegExp(`<(?:\\w+:)?${propName}\\s*>([^<]+)<\\/(?:\\w+:)?${propName}\\s*>`, 'i');
  const match = responseContent.match(regex);
  return match ? match[1].trim() : null;
}

/**
 * 从单个 WebDAV response 块中提取 href
 */
function extractResponseHref(responseContent) {
  return extractPropValue(responseContent, 'href');
}

/**
 * 尝试从字符串中解析日期
 * 支持多种常见日期格式：
 *   - ISO 8601: 2026-06-20T12:30:00Z
 *   - RFC 1123: Fri, 20 Jun 2026 12:30:00 GMT
 *   - HTTP 日期格式
 *   - 带时区的 ISO 格式
 */
function parseDate(dateStr) {
  if (!dateStr) return null;

  // 直接尝试标准解析
  let d = new Date(dateStr);
  if (!isNaN(d.getTime()) && d.getFullYear() > 2000) {
    return d;
  }

  // 尝试清理常见格式问题
  // 有些服务器返回的日期可能有多余空格或特殊字符
  const cleaned = dateStr.replace(/\s+/g, ' ').trim();
  d = new Date(cleaned);
  if (!isNaN(d.getTime()) && d.getFullYear() > 2000) {
    return d;
  }

  // 尝试替换特殊分隔符
  const normalized = dateStr.replace(/(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.\d+/, '$1-$2-$3T$4:$5:$6');
  d = new Date(normalized);
  if (!isNaN(d.getTime()) && d.getFullYear() > 2000) {
    return d;
  }

  core.warning(`[DATE] Failed to parse date string: "${dateStr}"`);
  return null;
}

/**
 * 尝试从目录名中解析时间戳
 * 支持格式：
 *   - ISO 时间戳: 2026-06-20T12-30-00
 *   - 简单日期: 2026-06-20
 */
function parseDateFromDirName(dirName) {
  // ISO 时间戳格式: 2026-06-20T12-30-00 (action 生成的格式)
  const isoMatch = dirName.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})$/);
  if (isoMatch) {
    const [, y, m, d, h, min, s] = isoMatch;
    return new Date(`${y}-${m}-${d}T${h}:${min}:${s}Z`);
  }

  // 简单日期格式: 2026-06-20
  const dateMatch = dirName.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dateMatch) {
    const [, y, m, d] = dateMatch;
    return new Date(`${y}-${m}-${d}T00:00:00Z`);
  }

  return null;
}

// ========== 版本清理功能 ==========

// 获取目录列表并解析创建时间
async function listDirectoriesWithDates(parentUrl) {
  try {
    const fixedUrl = fixWebDavUrl(parentUrl);
    core.info(`Listing directories in: ${fixedUrl}`);

    const depthHeader = { Depth: '1' };
    const listResponse = await webdavRequest('PROPFIND', fixedUrl, null, depthHeader);

    if (listResponse.statusCode !== 207) {
      core.warning(`Failed to list directories: ${listResponse.statusCode}`);
      return [];
    }

    if (DEBUG) {
      core.info(`[DEBUG] PROPFIND raw response:\n${listResponse.data.substring(0, 2000)}`);
    }

    // 解析 PROPFIND 响应获取目录和创建时间
    const directories = [];

    // 兼容不同 WebDAV 服务器的 XML 命名空间（d:, D:, lp1:, 或无命名空间）
    const responseRegex = /<(?:\w+:)?response[\s>][\s\S]*?<\/(?:\w+:)?response>/gi;
    let responseMatch;

    while ((responseMatch = responseRegex.exec(listResponse.data)) !== null) {
      const responseContent = responseMatch[0];

      // 提取 href - 兼容不同命名空间
      const href = extractResponseHref(responseContent);
      if (!href) continue;

      const decodedHref = decodeURIComponent(href);
      const dirName = decodedHref.split('/').filter(p => p).pop();

      // 跳过父目录本身和 latest 目录
      if (!dirName || dirName === 'latest') continue;

      // 尝试多种方式获取日期
      let date = null;

      // 1. 尝试 creationdate
      const creationStr = extractPropValue(responseContent, 'creationdate');
      if (creationStr) {
        date = parseDate(creationStr);
        if (date) {
          if (DEBUG) core.info(`[DEBUG] ${dirName}: creationdate = "${creationStr}" -> ${date.toISOString()}`);
        }
      }

      // 2. 尝试 getlastmodified
      if (!date) {
        const lastModStr = extractPropValue(responseContent, 'getlastmodified');
        if (lastModStr) {
          date = parseDate(lastModStr);
          if (date) {
            if (DEBUG) core.info(`[DEBUG] ${dirName}: getlastmodified = "${lastModStr}" -> ${date.toISOString()}`);
          }
        }
      }

      // 3. 尝试从目录名解析时间戳（对 action 自己创建的 ISO 时间戳目录最有效）
      if (!date) {
        date = parseDateFromDirName(dirName);
        if (date) {
          if (DEBUG) core.info(`[DEBUG] ${dirName}: parsed from directory name -> ${date.toISOString()}`);
        }
      }

      // 如果所有方式都失败，使用 Date(0) 并在日志中警告
      if (!date) {
        date = new Date(0);
        core.warning(`[CLEANUP] Could not determine date for directory "${dirName}", using epoch as fallback`);
      }

      // 构建完整 URL
      const fullUrl = decodedHref.startsWith('http') ? decodedHref : `${WEBDAV_URL}${decodedHref.startsWith('/') ? '' : '/'}${decodedHref}`;

      directories.push({
        name: dirName,
        url: fullUrl,
        date: date
      });
    }

    core.info(`Found ${directories.length} directories`);
    if (DEBUG) {
      for (const dir of directories) {
        core.info(`[DEBUG]   ${dir.name} -> ${dir.date.toISOString()}`);
      }
    }
    return directories;
  } catch (error) {
    core.error(`Error listing directories: ${error.message}`);
    return [];
  }
}

// 清理旧版本，只保留最新的 maxVersions 个
async function cleanupOldVersions(parentUrl, maxVersions) {
  try {
    const directories = await listDirectoriesWithDates(parentUrl);

    if (directories.length <= maxVersions) {
      core.info(`Found ${directories.length} version(s), no cleanup needed (limit: ${maxVersions})`);
      return;
    }

    // 按日期排序（旧的在前）
    directories.sort((a, b) => a.date - b.date);

    const toDelete = directories.slice(0, directories.length - maxVersions);
    core.info(`Cleaning up ${toDelete.length} old version(s), keeping latest ${maxVersions}`);

    for (const dir of toDelete) {
      core.info(`Deleting old version: ${dir.name} (date: ${dir.date.toISOString()})`);
      await deleteDirectory(dir.url);
    }

    core.info('Cleanup completed');
  } catch (error) {
    core.warning(`Error during cleanup: ${error.message}`);
    // 清理失败不应阻止上传
  }
}

// 上传文件
async function uploadFile(localPath, remoteUrl) {
  try {
    const fileContent = fs.readFileSync(localPath);
    core.info(`Uploading file: ${localPath} -> ${remoteUrl}`);

    const response = await webdavRequest('PUT', remoteUrl, fileContent, {
      'Content-Length': fileContent.length,
      'Content-Type': getContentType(localPath)
    });

    if (response.statusCode === 200 || response.statusCode === 201 || response.statusCode === 204) {
      core.info(`Uploaded successfully: ${localPath}`);
      successCount++;
      return true;
    } else if (response.statusCode === 403) {
      core.error(`Permission denied (403) when uploading ${localPath} to ${remoteUrl}`);
      core.error(`Response data: ${response.data}`);
      const fixedRemoteUrl = fixWebDavUrl(remoteUrl);
      if (fixedRemoteUrl !== remoteUrl) {
        core.info(`Trying with fixed URL: ${fixedRemoteUrl}`);
        const retryResponse = await webdavRequest('PUT', fixedRemoteUrl, fileContent, {
          'Content-Length': fileContent.length,
          'Content-Type': getContentType(localPath)
        });
        if (retryResponse.statusCode === 200 || retryResponse.statusCode === 201) {
          core.info(`Uploaded successfully with fixed URL: ${localPath}`);
          successCount++;
          return true;
        }
      }
      failureCount++;
      return false;
    } else {
      core.error(`Error uploading ${localPath}: ${response.statusCode} - ${response.data}`);
      failureCount++;
      return false;
    }
  } catch (error) {
    core.error(`Error uploading ${localPath}: ${error.message}`);
    failureCount++;
    return false;
  }
}

// 修复 WebDAV URL 格式
function fixWebDavUrl(url) {
  if (!url.endsWith('/')) {
    return url + '/';
  }
  return url;
}

// 获取文件内容类型
function getContentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const contentTypes = {
    '.html': 'text/html',
    '.css': 'text/css',
    '.js': 'application/javascript',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.eot': 'application/vnd.ms-fontobject',
    '.wasm': 'application/wasm',
    '.webp': 'image/webp',
    '.ico': 'image/x-icon',
    '.map': 'application/json',
    '.txt': 'text/plain',
    '.xml': 'application/xml',
  };
  return contentTypes[ext] || 'application/octet-stream';
}

// 递归上传目录
async function uploadDirectory(localDir, remoteDir) {
  const dirCreated = await createDirectory(remoteDir);
  if (!dirCreated) {
    core.error(`Failed to create directory: ${remoteDir}`);
    return;
  }

  try {
    const files = fs.readdirSync(localDir);
    core.info(`Uploading ${files.length} items from ${localDir}`);

    for (const file of files) {
      const localPath = path.join(localDir, file);
      const remotePath = `${remoteDir}/${file}`;
      const stats = fs.statSync(localPath);

      if (stats.isDirectory()) {
        await uploadDirectory(localPath, remotePath);
      } else {
        await uploadFile(localPath, remotePath);
      }
    }
  } catch (error) {
    core.error(`Error reading directory ${localDir}: ${error.message}`);
  }
}

// 主函数
async function main() {
  core.info('Starting WebDAV upload...');
  core.info('====================================');

  // 打印配置信息（隐藏敏感信息）
  core.info(`WebDAV URL: ${WEBDAV_URL}`);
  core.info(`WebDAV Username: ${WEBDAV_USERNAME}`);
  core.info(`WebDAV Root: ${WEBDAV_ROOT || '(empty)'}`);
  core.info(`Source Directory: ${SOURCE_DIRECTORY}`);
  core.info(`Copy to Latest: ${COPY_TO_LATEST}`);
  core.info(`Keep Versions: ${KEEP_VERSIONS}`);
  core.info('====================================');

  // 获取上传目录
  const uploadDir = getUploadDirectory();

  // 构建远程 URL
  const remoteBaseUrl = `${WEBDAV_URL}${WEBDAV_ROOT ? `/${WEBDAV_ROOT}` : ''}/${uploadDir}`;

  core.info(`Uploading to: ${remoteBaseUrl}`);
  core.info('====================================');

  // ========== 清理旧版本 ==========
  const parentUrl = `${WEBDAV_URL}${WEBDAV_ROOT ? `/${WEBDAV_ROOT}` : ''}`;
  await cleanupOldVersions(parentUrl, KEEP_VERSIONS);

  // 开始上传
  await uploadDirectory(SOURCE_DIRECTORY, remoteBaseUrl);

  // 打印上传结果
  core.info('====================================');
  core.info(`Upload Summary:`);
  core.info(`Successfully uploaded: ${successCount} files`);
  core.info(`Failed to upload: ${failureCount} files`);

  if (failureCount > 0) {
    core.setFailed('Upload completed with errors!');
    process.exit(1);
  } else {
    core.info('Upload completed successfully!');
    core.info(`Uploaded to: ${remoteBaseUrl}`);
    core.setOutput('upload-url', remoteBaseUrl);
  }

  // ========== 复制到 latest 目录 ==========
  if (COPY_TO_LATEST) {
    core.info('====================================');
    core.info('Starting latest directory copy...');
    core.info('====================================');

    // latest 目录放在 webdav-root 内部
    const latestBaseUrl = `${WEBDAV_URL}${WEBDAV_ROOT ? `/${WEBDAV_ROOT}` : ''}/latest`;
    core.info(`Latest directory URL: ${latestBaseUrl}`);

    // 1. 清空 latest 目录
    core.info('Clearing existing latest directory...');
    await deleteDirectory(latestBaseUrl);

    // 2. 上传到 latest 目录
    const latestSuccessCount = successCount;
    const latestFailureCount = failureCount;

    await uploadDirectory(SOURCE_DIRECTORY, latestBaseUrl);

    const latestUploaded = successCount - latestSuccessCount;
    const latestFailed = failureCount - latestFailureCount;

    core.info('====================================');
    core.info(`Latest Directory Summary:`);
    core.info(`Successfully uploaded: ${latestUploaded} files`);
    core.info(`Failed to upload: ${latestFailed} files`);

    if (latestFailed > 0) {
      core.setFailed('Latest directory copy completed with errors!');
      process.exit(1);
    } else {
      core.info(`Latest directory updated successfully: ${latestBaseUrl}`);
      core.setOutput('latest-url', latestBaseUrl);
    }
  }
}

// 运行主函数
main().catch((error) => {
  core.setFailed(`Error during upload: ${error.message}`);
  process.exit(1);
});
