# Upload to WebDAV GitHub Action

This GitHub Action allows you to upload files to a WebDAV server. It supports automatic directory creation and handles both tagged and untagged uploads differently.

## Features

- Upload files to any WebDAV server
- Automatic directory creation (including parent directories)
- Different upload behavior for tagged and untagged commits:
  - Tagged commits: Uploads to a fixed `release` directory
  - Untagged commits: Uploads to a timestamp-based directory
- Customizable upload directory
- Debug mode for troubleshooting

## Inputs

| Input | Description | Required | Default |
|-------|-------------|----------|---------|
| `webdav-url` | WebDAV server URL | Yes | - |
| `webdav-username` | WebDAV username | Yes | - |
| `webdav-password` | WebDAV password | Yes | - |
| `webdav-root` | WebDAV root directory prefix | No | Empty string |
| `source-directory` | Local directory to upload | Yes | - |
| `upload-directory` | Remote subdirectory name (overrides automatic behavior) | No | Empty string |
| `copy-to-latest` | Also copy files to a `latest` directory under webdav-root | No | `true` |
| `debug` | Enable debug mode | No | `false` |

## Outputs

| Output | Description |
|--------|-------------|
| `upload-url` | The URL where files were uploaded to |

## Example Usage

### Basic Usage

```yaml
name: Build and Upload to WebDAV

on:
  push:
    branches:
      - main
    tags:
      - '**'

jobs:
  upload:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout code
        uses: actions/checkout@v4

      - name: Build project
        run: |
          # Your build commands here
          mkdir -p dist
          echo "Hello World" > dist/index.html

      - name: Upload to WebDAV
        uses: yourusername/action-upload-webdav@v1
        with:
          webdav-url: ${{ secrets.WEBDAV_URL }}
          webdav-username: ${{ secrets.WEBDAV_USERNAME }}
          webdav-password: ${{ secrets.WEBDAV_PASSWORD }}
          webdav-root: my-app
          source-directory: dist
```

### Custom Upload Directory

```yaml
- name: Upload to WebDAV with custom directory
  uses: yourusername/action-upload-webdav@v1
  with:
    webdav-url: ${{ secrets.WEBDAV_URL }}
    webdav-username: ${{ secrets.WEBDAV_USERNAME }}
    webdav-password: ${{ secrets.WEBDAV_PASSWORD }}
    source-directory: dist
    upload-directory: my-custom-directory
```

### Debug Mode

```yaml
- name: Upload to WebDAV with debug mode
  uses: yourusername/action-upload-webdav@v1
  with:
    webdav-url: ${{ secrets.WEBDAV_URL }}
    webdav-username: ${{ secrets.WEBDAV_USERNAME }}
    webdav-password: ${{ secrets.WEBDAV_PASSWORD }}
    source-directory: dist
    debug: true
```

## How It Works

### Upload Directory Logic

The action automatically determines the upload subdirectory based on the current git state:

| Condition | Subdirectory | Example | Behavior |
|-----------|-------------|---------|----------|
| Current commit has a git tag | `release` | `release/` | **Overwritten** on each tagged deploy |
| Current commit has no git tag | ISO timestamp | `2026-06-06T02-30-00/` | **New directory** created each time |
| Custom `upload-directory` provided | User-defined | `my-dir/` | Overrides the above rules |

**Final URL structure:**
```
{webdav-url}/{webdav-root}/{upload-directory}/
```

Example with `webdav-root: online/my-app`:
```
online/
└── my-app/
    ├── release/              ← Tagged commits
    ├── 2026-06-06T02-30-00/  ← Untagged commits
    └── latest/               ← Copy of most recent upload (if copy-to-latest enabled)
```

### copy-to-latest

When `copy-to-latest: true` (default):
1. Clears the existing `{webdav-root}/latest/` directory
2. Copies all uploaded files to `latest/`
3. `latest/` always points to the most recent deployment

### Version Cleanup

Before each upload, the action automatically cleans up old versions:
- **Keeps**: Latest 5 version directories (excluding `latest/`)
- **Deletes**: Oldest directories first (sorted by `creationdate`)
- **Note**: `release/` counts toward the 5-version limit

### Step-by-Step Process

1. **Authentication**: Uses basic authentication with the provided username and password
2. **Directory Decision**: Determines upload subdirectory (release / timestamp / custom)
3. **Cleanup**: Removes old version directories if exceeding the limit
4. **Directory Creation**: Creates the upload directory and any parent directories
5. **File Upload**: Uploads all files from the source directory recursively
6. **Latest Copy**: If enabled, copies files to the `latest/` directory

## Security Considerations

- **Secrets**: Always store WebDAV credentials as GitHub Secrets, never hardcode them
- **Permissions**: Ensure your WebDAV server has appropriate permissions for the user
- **URLs**: Use HTTPS for WebDAV URLs to encrypt traffic

## License

MIT
