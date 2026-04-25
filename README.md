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
| `webdav-root` | WebDAV root directory | No | Empty string |
| `source-directory` | Local directory to upload | Yes | - |
| `upload-directory` | Remote directory to upload to (overrides automatic behavior) | No | Empty string |
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

1. **Authentication**: Uses basic authentication with the provided username and password
2. **Directory Handling**: Automatically creates directories as needed
3. **Upload Logic**:
   - If a git tag is present, uploads to `release` directory
   - If no git tag, uploads to a timestamp-based directory
   - If custom `upload-directory` is provided, uses that instead
4. **File Upload**: Uploads all files from the source directory recursively

## Security Considerations

- **Secrets**: Always store WebDAV credentials as GitHub Secrets, never hardcode them
- **Permissions**: Ensure your WebDAV server has appropriate permissions for the user
- **URLs**: Use HTTPS for WebDAV URLs to encrypt traffic

## License

MIT
