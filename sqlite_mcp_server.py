import os
import sqlite3
import json
import asyncio
from mcp.server import Server
from mcp.server.stdio import stdio_server
from mcp.types import Tool, TextContent

DB_PATH = os.environ.get("SQLITE_DB_PATH", r"C:\Projects\gold-regime-algo\data\gold-regime.db")

def get_connection():
    db_dir = os.path.dirname(DB_PATH)
    if db_dir:
        os.makedirs(db_dir, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn

server = Server("sqlite-gold-regime")

@server.list_tools()
async def list_tools():
    return [
        Tool(
            name="sqlite_query",
            description="Run a read-only SQL query against the SQLite database",
            inputSchema={
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "SQL SELECT query to execute"}
                },
                "required": ["query"]
            }
        ),
        Tool(
            name="sqlite_execute",
            description="Execute an INSERT, UPDATE, DELETE, or DDL statement",
            inputSchema={
                "type": "object",
                "properties": {
                    "statement": {"type": "string", "description": "SQL statement to execute"}
                },
                "required": ["statement"]
            }
        ),
        Tool(
            name="sqlite_tables",
            description="List all tables in the database",
            inputSchema={"type": "object", "properties": {}}
        ),
        Tool(
            name="sqlite_schema",
            description="Get the schema for a specific table",
            inputSchema={
                "type": "object",
                "properties": {
                    "table": {"type": "string", "description": "Table name"}
                },
                "required": ["table"]
            }
        ),
    ]

@server.call_tool()
async def call_tool(name: str, arguments: dict):
    conn = get_connection()
    try:
        if name == "sqlite_query":
            query = arguments["query"]
            cursor = conn.execute(query)
            rows = [dict(row) for row in cursor.fetchall()]
            return [TextContent(type="text", text=json.dumps(rows, indent=2, default=str))]
        
        elif name == "sqlite_execute":
            statement = arguments["statement"]
            conn.execute(statement)
            conn.commit()
            return [TextContent(type="text", text=f"Executed: {statement}")]
        
        elif name == "sqlite_tables":
            cursor = conn.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
            rows = [row[0] for row in cursor.fetchall()]
            return [TextContent(type="text", text=json.dumps(rows, indent=2))]
        
        elif name == "sqlite_schema":
            table = arguments["table"]
            cursor = conn.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name=?", (table,))
            row = cursor.fetchone()
            if row:
                return [TextContent(type="text", text=row[0])]
            return [TextContent(type="text", text=f"Table '{table}' not found")]
    finally:
        conn.close()

async def main():
    async with stdio_server() as (read_stream, write_stream):
        await server.run(read_stream, write_stream, server.create_initialization_options())

if __name__ == "__main__":
    asyncio.run(main())
