from typing import Optional

from fastapi import APIRouter
from pydantic import BaseModel

from autonomy import get_idle_config, idle_autonomy_mgr, save_idle_config


router = APIRouter(prefix="/api/idle-autonomy", tags=["idle-autonomy"])


class IdleConfigUpdate(BaseModel):
    enabled: Optional[bool] = None
    interval_minutes: Optional[int] = None
    interval_min_minutes: Optional[int] = None
    interval_max_minutes: Optional[int] = None
    actions: Optional[dict[str, bool]] = None


@router.get("/config")
async def read_idle_config():
    return get_idle_config()


@router.put("/config")
async def update_idle_config(body: IdleConfigUpdate):
    return save_idle_config(
        enabled=body.enabled,
        interval_minutes=body.interval_minutes,
        interval_min_minutes=body.interval_min_minutes,
        interval_max_minutes=body.interval_max_minutes,
        actions=body.actions,
    )


@router.post("/run-once")
async def run_idle_once():
    return await idle_autonomy_mgr.run_once(manual=True)
