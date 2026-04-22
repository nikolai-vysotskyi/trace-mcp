wsgi_app = "wsgi:application"
bind = "0.0.0.0:8000"
workers = 4
worker_class = "sync"
timeout = 30
