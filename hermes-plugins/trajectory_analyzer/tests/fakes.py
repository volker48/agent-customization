class FakeContext:
    def __init__(self):
        self.commands = []

    def register_cli_command(self, **kwargs):
        self.commands.append(kwargs)


class FakeStore:
    def __init__(self, sessions=(), messages=()):
        self.sessions = list(sessions)
        self.messages = list(messages)
        self.session_calls = []
        self.message_calls = []

    def fetch_sessions(self, days, source, now):
        self.session_calls.append((days, source, now))
        return self.sessions

    def fetch_active_messages(self, days, source, now):
        self.message_calls.append((days, source, now))
        return self.messages
