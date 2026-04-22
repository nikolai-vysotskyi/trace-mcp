import uvicorn

from app import app


def main() -> None:
    uvicorn.run(app, host="0.0.0.0", port=8000, workers=4)


if __name__ == "__main__":
    main()
