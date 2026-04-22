import uvicorn


def dev() -> None:
    uvicorn.run("app:app", host="127.0.0.1", port=8001, reload=True)
