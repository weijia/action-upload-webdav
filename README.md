# Upload to WebDAV GitHub Action

Upload files to any WebDAV server from GitHub Actions. Supports automatic version management, old version cleanup, and tagged/untagged deploy differentiation.

## Features

- Upload files to any WebDAV server (Nginx, Apache, Nextcloud, etc.)
- Automatic directory creation (including parent directories)
- Automatic version cleanup (configurable retention)
- Different upload behavior for tagged and untagged commits
- `latest/` directory always points to the most recent deployment
- Compatible with various WebDAV server XML namespace formats
- Debug mode for troubleshooting

## Inputs

| Input | Description | Required | Default |
|-------|-------------|----------|---------|
| `webdav-url` | WebDAV server URL (e.g. `https://dav.example.com`) | Yes | - |
| `webdav-username` | WebDAV username | Yes | - |
| `webdav-password` | WebDAV password | Yes | - |
| `webdav-root` | Root directory prefix on the server (e.g. `online/my-app`) | No | `''` |
| `source-directory` | Local directory to upload | Yes | - |
| `upload-directory` | Remote subdirectory name. Overrides automatic behavior. | No | `''` |
| `copy-to-latest` | Copy files to `latest/` directory under `webdav-root` | No | `true` |
| `keep-versions` | Number of old version directories to keep. Set to `0` to disable cleanup. | No | `5` |
| `debug` | Enable debug mode for detailed logging | No | `false` |

## Outputs

| Output | Description |
|--------|-------------|
| `upload-url` | The URL where files were uploaded |
| `latest-url` | The URL of the `latest/` directory (if `copy-to-latest` is enabled) |

## Example Usage

### Basic Usage

```yaml
name: Build and Deploy

on:
  push:
    branches:
      - main
    tags:
      - 'v*'

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Build
        run: npm run build

      - uses: weijia/action-upload-webdav@master
        with:
          webdav-url: ${{ secrets.WEBDAV_URL }}
          webdav-username: ${{ secrets.WEBDAV_USERNAME }}
          webdav-password: ${{ secrets.WEBDAV_PASSWORD }}
          webdav-root: online/my-app
          source-directory: ./dist
```

### With Custom Upload Directory

```yaml
- uses: weijia/action-upload-webdav@master
  with:
    webdav-url: ${{ secrets.WEBDAV_URL }}
    webdav-username: ${{ secrets.WEBDAV_USERNAME }}
    webdav-password: ${{ secrets.WEBDAV_PASSWORD }}
    source-directory: ./dist
    upload-directory: staging
```

### With Custom Version Retention

```yaml
- uses: weijia/action-upload-webdav@master
  with:
    webdav-url: ${{ secrets.WEBDAV_URL }}
    webdav-username: ${{ secrets.WEBDAV_USERNAME }}
    webdav-password: ${{ secrets.WEBDAV_PASSWORD }}
    webdav-root: online/my-app
    source-directory: ./dist
    keep-versions: 10    # Keep 10 versions instead of default 5
```

### Debug Mode

```yaml
- uses: weijia/action-upload-webdav@master
  with:
    webdav-url: ${{ secrets.WEBDAV_URL }}
    webdav-username: ${{ secrets.WEBDAV_USERNAME }}
    webdav-password: ${{ secrets.WEBDAV_PASSWORD }}
    source-directory: ./dist
    debug: true
```

## How It Works

### Upload Directory Logic

The action automatically determines the upload subdirectory based on the current git state:

| Condition | Subdirectory | Example | Behavior |
|-----------|-------------|---------|----------|
| `upload-directory` is set | User-defined | `staging/` | Overrides all automatic behavior |
| Current commit has a git tag | `release` | `release/` | Overwritten on each tagged deploy |
| Current commit has no git tag | ISO timestamp | `2026-06-20T12-30-00/` | New directory created each time |

### Directory Structure

With `webdav-root: online/my-app`:

```
online/
└── my-app/
    ├── release/              ← Tagged commits (overwritten)
    ├── 2026-06-20T12-30-00/  ← Untagged commits (new each time)
    ├── 2026-06-19T08-15-00/  ← Older untagged deploy
    └── latest/               ← Always points to most recent upload
```

### Version Cleanup

Before each upload, the action automatically cleans up old version directories:

1. Lists all subdirectories under `webdav-root` (excluding `latest/`)
2. Sorts them by date (oldest first)
3. Deletes the oldest directories, keeping only the number specified by `keep-versions`
4. Set `keep-versions: 0` to disable cleanup entirely

Date detection uses a multi-strategy approach for maximum compatibility:
1. WebDAV `creationdate` property
2. WebDAV `getlastmodified` property
3. Parsing the directory name (for ISO timestamp directories like `2026-06-20T12-30-00`)

### copy-to-latest

When `copy-to-latest: true` (default):

1. Clears the existing `{webdav-root}/latest/` directory
2. Uploads all files to `latest/`
3. `latest/` always reflects the most recent deployment

### Step-by-Step Process

1. **Authentication** - Basic auth with provided credentials
2. **Directory Decision** - Determines upload subdirectory
3. **Cleanup** - Removes old version directories if exceeding limit
4. **Directory Creation** - Creates upload directory and parent directories
5. **File Upload** - Uploads all files recursively
6. **Latest Copy** - If enabled, copies files to `latest/`

## WebDAV Server Compatibility

This action has been tested and is compatible with:

- **Nginx** (with `ngx_http_dav_module` or `nginx-dav-ext-module`)
- **Apache** (with `mod_dav` / `mod_dav_fs`)
- **Nextcloud** / **ownCloud**
- **rclone serve webdav**
- Any RFC 4918 compliant WebDAV server

The XML parser handles various namespace formats: `d:`, `D:`, `lp1:`, or no namespace prefix.

## Troubleshooting

### Enable Debug Mode

Set `debug: true` to see detailed request/response logs:

```yaml
- uses: weijia/action-upload-webdav@master
  with:
    debug: true
    # ... other inputs
```

### Common Issues

| Issue | Solution |
|-------|----------|
| `403 Forbidden` | Check WebDAV server permissions for write access |
| `409 Conflict` | The action will auto-create parent directories |
| Old directories not being cleaned | Enable `debug: true` and check the date parsing logs. Some servers may not return `creationdate`. The action falls back to parsing directory names. |
| Upload fails silently | Check GitHub Actions log for `[ERROR]` messages |

## Security

- Store WebDAV credentials as **GitHub Secrets**, never hardcode them
- Use **HTTPS** URLs for encrypted traffic
- Ensure your WebDAV server has appropriate write permissions

## License

MIT
