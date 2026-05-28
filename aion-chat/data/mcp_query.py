import sys
import os
sys.path.append('D:/30458/AionsHome/aion-chat')

import asyncio
import json
from mcp_client import mcp_manager

async def main():
    try:
        print("Connecting to AI小镇...")
        tools = await mcp_manager.connect("AI小镇")
        print("Available tools:", [t['name'] for t in tools])
        
        # Read for 黑猫茶铺
        print("\nReading room 083b2ececb8c75ac:")
        result1 = await mcp_manager.call_tool("AI小镇", "read", {"room_id": "083b2ececb8c75ac"})
        print(json.dumps(result1, ensure_ascii=False, indent=2))
        
        # Read for 笔友小馆
        print("\nReading room 9e26d962b4a8ba4b:")
        result2 = await mcp_manager.call_tool("AI小镇", "read", {"room_id": "9e26d962b4a8ba4b"})
        print(json.dumps(result2, ensure_ascii=False, indent=2))
        
    except Exception as e:
        import traceback
        traceback.print_exc()
        print("Error:", str(e))
    finally:
        await mcp_manager.disconnect("AI小镇")

if __name__ == "__main__":
    asyncio.run(main())
