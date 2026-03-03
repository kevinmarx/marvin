# MCP plugins for Docker build

Before building the Docker image, copy the MCP plugin directories here:

```bash
cp -r /path/to/your/plugins/linear-mcp deploy/plugins/
cp -r /path/to/your/plugins/local-memory-mcp deploy/plugins/
# Also needed if running Deep Thought in the container:
cp -r /path/to/your/plugins/datadog-mcp deploy/plugins/
```

These are bundled into the image at `/home/marvin/plugins/`.
