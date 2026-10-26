class DummyClient:
    def get_object(self, *args, **kwargs):
        return None

    def get_parameter(self, *args, **kwargs):
        return None

    def invoke(self, *args, **kwargs):
        return None

dummy = DummyClient()

def dummy_worker():
    dummy.get_object('a')
    dummy.get_parameter('b')
    dummy.invoke('c')
