import unittest

from src.services.fp_browser_client import FPBrowserClient


class FPBrowserClientTest(unittest.TestCase):
    def test_browser_api_client_ignores_system_proxy_settings(self) -> None:
        client = FPBrowserClient()._client()
        try:
            self.assertFalse(getattr(client, "_trust_env", True))
        finally:
            # _client is synchronous but returns an AsyncClient.  Closing is not
            # required for this attribute assertion and would need an event loop.
            pass


if __name__ == "__main__":
    unittest.main()
