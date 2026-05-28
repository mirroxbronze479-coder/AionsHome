import sys
import os
import asyncio
import json

sys.path.append('D:/30458/AionsHome/aion-chat')
from mcp_client import mcp_manager

async def main():
    try:
        print("Connecting to AI小镇...")
        tools = await mcp_manager.connect("AI小镇")
        
        print("\nCalling my_status:")
        result = await mcp_manager.call_tool("AI小镇", "my_status", {})
        print(json.dumps(result, ensure_ascii=False, indent=2))
        
    except Exception as e:
        import traceback
        traceback.print_exc()
        print("Error:", str(e))
    finally:
        await mcp_manager.disconnect("AI小镇")

if __name__ == "__main__":
    asyncio.run(main())
