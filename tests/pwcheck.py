import asyncio, sys
from playwright.async_api import async_playwright

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(args=['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader'])
        pg = await b.new_page(viewport={'width':1280,'height':720})
        logs=[]
        pg.on('console', lambda m: logs.append((m.type, m.text)))
        pg.on('pageerror', lambda e: logs.append(('pageerror', str(e))))
        await pg.goto('http://localhost:8765/index.html')
        try:
            await pg.wait_for_function("window.__BOOT_DONE === true", timeout=90000)
        except Exception as e:
            print("BOOT TIMEOUT:", e)
        await pg.wait_for_timeout(3000)
        st = await pg.evaluate("window.__GAME_STATE || 'none'")
        print("STATE:", st)
        for t_,m in logs[:80]:
            print(f"[{t_}] {m[:240]}")
        await b.close()

asyncio.run(main())
