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

          // 处理 301 重定向
          if (res.statusCode === 301 && res.headers.location) {
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
    core.error(`Error creating directory ${fixedDirectoryUrl}: ${error.message}`);
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
      // 解析 XML 获取所有子资源的 URL
      const hrefRegex = /<d:href>([^<]+)<\/d:href>/gi;
      const hrefs = [];
      let match;
      while ((match = hrefRegex.exec(listResponse.data)) !== null) {
        hrefs.push(match[1]);
      }

      // 从最深层开始删除（倒序，排除目录本身）
      const sortedHrefs = hrefs
        .map(h => decodeURIComponent(h))
        .filter(h => h !== fixedDirectoryUrl && h !== fixedDirectoryUrl.replace(/\/$/, ''))
        .sort((a, b) => b.split('/').length - a.split('/').length);

      for (const href of sortedHrefs) {
        const isDir = href.endsWith('/');
        const method = isDir ? 'DELETE' : 'DELETE';
        const fullHref = href.startsWith("http") ? href : `${WEBDAV_URL}${href.startsWith("/") ? "" : "/"}${href}`;
        const delResponse = await webdavRequest(method, fullHref);
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
    '.eot': 'application/vnd.ms-fontobject'
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
  core.info('====================================');

  // 获取上传目录
  const uploadDir = getUploadDirectory();

  // 构建远程 URL
  const remoteBaseUrl = `${WEBDAV_URL}${WEBDAV_ROOT ? `/${WEBDAV_ROOT}` : ''}/${uploadDir}`;

  core.info(`Uploading to: ${remoteBaseUrl}`);
  core.info('====================================');

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

    // latest 目录与 webdav-root 同级（不是在其内部）
    // 例如：webdav-root = online/my-app → latest = online/latest
    const rootParent = WEBDAV_ROOT ? WEBDAV_ROOT.substring(0, WEBDAV_ROOT.lastIndexOf('/')) : '';
    const latestBaseUrl = `${WEBDAV_URL}${rootParent ? `/${rootParent}` : ''}/latest`;
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
