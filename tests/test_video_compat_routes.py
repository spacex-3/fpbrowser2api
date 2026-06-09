import unittest

from fastapi import HTTPException

from src.api import routes


class VideoCompatRoutesTest(unittest.TestCase):
    def test_veo_omni_flash_video_edit_accepts_documented_ten_seconds(self) -> None:
        task_type_code, payload = routes._normalize_video_task_payload(
            {
                "model": "veo-omni-flash-video-edit",
                "prompt": "make the reference video brighter",
                "duration": 10,
                "aspect_ratio": "16:9",
                "video_url": "https://cdn.example.com/input.mp4",
                "Ingredients_images": ["https://cdn.example.com/ref.png"],
            }
        )

        self.assertEqual(task_type_code, "veo_workflow")
        self.assertEqual(payload["duration"], 10)
        self.assertEqual(payload["n_frames"], 300)
        self.assertEqual(payload["video_model"], "abra_t2v_10s")
        self.assertEqual(payload["model"], "veo-omni-flash")
        self.assertEqual(payload["video_url"], "https://cdn.example.com/input.mp4")

    def test_veo_omni_flash_video_edit_rejects_non_ten_seconds(self) -> None:
        with self.assertRaises(HTTPException) as ctx:
            routes._normalize_video_task_payload(
                {
                    "model": "veo-omni-flash-video-edit",
                    "prompt": "make the reference video brighter",
                    "duration": 8,
                    "video_url": "https://cdn.example.com/input.mp4",
                }
            )

        self.assertEqual(ctx.exception.status_code, 400)
        self.assertIn("veo-omni-flash-video-edit only supports duration=10", ctx.exception.detail)


if __name__ == "__main__":
    unittest.main()
