import tempfile
import unittest
from pathlib import Path

from src.core.database import Database


class DatabaseWindowSyncTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.db = Database(str(Path(self._tmp.name) / "test.db"))
        await self.db.init_db()
        self.project_id = await self.db.create_project("p")
        self.browser_id = await self.db.create_browser(
            self.project_id,
            "b",
            "http://127.0.0.1:45678",
            "roxy",
        )
        self.space_pk = await self.db.create_space(self.browser_id, "s", "112343", "131373")

    async def asyncTearDown(self) -> None:
        self._tmp.cleanup()

    async def test_upsert_windows_updates_existing_window_in_same_space(self) -> None:
        first = await self.db.upsert_windows(
            self.space_pk,
            [
                {
                    "window_key": "window-1",
                    "window_name": "Old Name",
                    "window_sort_num": 1,
                    "enabled": True,
                    "deleted": False,
                }
            ],
        )
        second = await self.db.upsert_windows(
            self.space_pk,
            [
                {
                    "window_key": "window-1",
                    "window_name": "New Name",
                    "window_sort_num": 2,
                    "enabled": True,
                    "deleted": False,
                }
            ],
        )
        windows = await self.db.list_windows(self.space_pk)

        self.assertEqual(first["affected"], 1)
        self.assertEqual(second["affected"], 1)
        self.assertEqual(second["skipped"], 0)
        self.assertEqual(len(windows), 1)
        self.assertEqual(windows[0].window_name, "New Name")
        self.assertEqual(windows[0].window_sort_num, 2)

    async def test_upsert_windows_ignores_matching_window_in_deleted_space(self) -> None:
        await self.db.upsert_windows(
            self.space_pk,
            [
                {
                    "window_key": "window-1",
                    "window_name": "Deleted Space Window",
                    "window_sort_num": 1,
                    "enabled": True,
                    "deleted": False,
                }
            ],
        )
        await self.db.delete_space(self.space_pk)
        other_browser_id = await self.db.create_browser(
            self.project_id,
            "b2",
            "http://127.0.0.1:45678",
            "roxy",
        )
        new_space_pk = await self.db.create_space(other_browser_id, "s2", "112343", "131373")

        result = await self.db.upsert_windows(
            new_space_pk,
            [
                {
                    "window_key": "window-1",
                    "window_name": "Active Space Window",
                    "window_sort_num": 2,
                    "enabled": True,
                    "deleted": False,
                }
            ],
        )
        windows = await self.db.list_windows(new_space_pk)

        self.assertEqual(result["affected"], 1)
        self.assertEqual(result["skipped"], 0)
        self.assertEqual(len(windows), 1)
        self.assertEqual(windows[0].window_name, "Active Space Window")


if __name__ == "__main__":
    unittest.main()
