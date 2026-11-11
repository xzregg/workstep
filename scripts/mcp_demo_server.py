"""Local stdio MCP demo: no file access, account login, or network listener.

Configure the connector with the daemon virtualenv's Python executable and
this file's absolute path as its single argument. Dependencies are supplied by
apps/daemon/.venv. Optional environment: WORKSTEP_MCP_DEMO_LABEL.
"""
import os

from mcp.server.fastmcp import FastMCP

server = FastMCP('WorkStep MCP Demo')


@server.tool()
def echo(message: str) -> dict:
    """返回输入文本，用于确认 MCP 工具调用和中文传输正常。"""
    return {'echo': message}


@server.tool()
def add(a: float, b: float) -> dict:
    """计算两个数的和，用于验证结构化参数与结果。"""
    return {'result': a + b}


@server.tool()
def get_demo_info() -> dict:
    """读取测试服务名称与专用测试标签，不读取其他环境变量。"""
    return {'name': 'WorkStep MCP Demo',
            'label': os.environ.get('WORKSTEP_MCP_DEMO_LABEL', 'WorkStep 本地测试'),
            'tool_count': 3}


if __name__ == '__main__':
    server.run(transport='stdio')
