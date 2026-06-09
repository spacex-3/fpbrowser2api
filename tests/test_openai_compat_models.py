import unittest

from src.api import routes


class OpenAICompatModelsTest(unittest.TestCase):
    def test_fpbrowser_use_noop_model_is_not_exposed(self) -> None:
        self.assertNotIn("fpbrowser-use", routes.OPENAI_COMPAT_NOOP_MODELS)
        self.assertNotIn("fpbrowser-use", routes.OPENAI_COMPAT_MODEL_SET)


if __name__ == "__main__":
    unittest.main()
