from flask import Flask

application = Flask(__name__)


@application.route("/")
def index() -> str:
    return "hello"
