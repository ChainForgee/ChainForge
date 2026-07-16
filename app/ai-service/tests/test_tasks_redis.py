import json
import time
from unittest.mock import MagicMock, patch
import pytest
import tasks

class MockRedis:
    def __init__(self):
        self.store = {}
        self.ttls = {}

    def setex(self, key: str, time_to_live: int, value: str):
        self.store[key] = value
        self.ttls[key] = time.time() + time_to_live

    def get(self, key: str):
        if key in self.store:
            if time.time() < self.ttls[key]:
                return self.store[key]
            else:
                del self.store[key]
                del self.ttls[key]
        return None

    def ttl(self, key: str):
        if key in self.store:
            remaining = self.ttls[key] - time.time()
            return int(remaining) if remaining > 0 else -2
        return -2


@pytest.fixture
def mock_redis():
    mr = MockRedis()
    with patch("tasks.get_redis_client", return_value=mr):
        # Reset lazy client to avoid caching previous states
        with patch("tasks.redis_client", mr):
            yield mr


def test_set_status_writes_to_redis_with_ttl(mock_redis):
    task_id = "test-task-1"
    payload = {"status": "processing", "result": None, "error": None}
    
    tasks.set_status(task_id, payload)
    
    key = f"task_status:{task_id}"
    assert key in mock_redis.store
    
    stored_data = json.loads(mock_redis.store[key])
    assert stored_data["status"] == "processing"
    
    # Assert TTL is 24 hours (86400 seconds)
    remaining_ttl = mock_redis.ttl(key)
    assert 86300 <= remaining_ttl <= 86400


def test_get_task_status_fallback_to_redis(mock_redis):
    task_id = "test-task-2"
    payload = {"status": "completed", "result": {"data": 123}, "error": None}
    
    # Populate redis
    tasks.set_status(task_id, payload)
    
    # Celery raises Exception or returns non-ready task to trigger fallback
    mock_async_result = MagicMock()
    mock_async_result.ready.return_value = False
    mock_async_result.started.return_value = False
    
    with patch("tasks.AsyncResult", return_value=mock_async_result):
        status = tasks.get_task_status(task_id)
        
    assert status["task_id"] == task_id
    assert status["status"] == "completed"
    assert status["result"] == {"data": 123}
    assert status["error"] is None


def test_get_task_status_celery_first(mock_redis):
    task_id = "test-task-3"
    
    # Populate Redis with a different status
    tasks.set_status(task_id, {"status": "processing", "result": None, "error": None})
    
    # Celery returns ready task (completed)
    mock_async_result = MagicMock()
    mock_async_result.ready.return_value = True
    mock_async_result.successful.return_value = True
    mock_async_result.result = {"celery_data": 456}
    
    with patch("tasks.AsyncResult", return_value=mock_async_result):
        status = tasks.get_task_status(task_id)
        
    # Should use Celery result, not Redis
    assert status["status"] == "completed"
    assert status["result"] == {"celery_data": 456}


def test_e2e_cross_process_observation(mock_redis):
    # Simulate Process A updating the status
    task_id = "cross-process-task-id"
    tasks.update_task_status(task_id, "processing")
    
    # Simulate Process B retrieving the status
    mock_async_result = MagicMock()
    mock_async_result.ready.return_value = False
    mock_async_result.started.return_value = False
    
    with patch("tasks.AsyncResult", return_value=mock_async_result):
        status_b = tasks.get_task_status(task_id)
        
    assert status_b["task_id"] == task_id
    assert status_b["status"] == "processing"
