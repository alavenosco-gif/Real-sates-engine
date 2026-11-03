import asyncio
import hashlib
import json
import os
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Annotated
from urllib.parse import quote

import httpx
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, ConfigDict, EmailStr, Field, field_validator


BROKER_PHONE = "002032293770"
LEADS_FILE = Path(os.getenv("LEADS_FILE", "data/leads.jsonl"))
TELEGRAM_BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN", "")
TELEGRAM_CHAT_ID = os.getenv("TELEGRAM_CHAT_ID", "")
BROKER_TELEGRAM_URL = os.getenv("BROKER_TELEGRAM_URL", "https://t.me/")

# Use exact origins, for example:
# CORS_ORIGINS=https://yourname.github.io,https://www.example.com
CORS_ORIGINS = [
    origin.strip().rstrip("/")
    for origin in os.getenv("CORS_ORIGINS", "").split(",")
    if origin.strip()
]

app = FastAPI(title="Real Estate Broker API", version="1.0.0")

# Do not use "*" for origins when credentials are enabled.
app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_credentials=False,
    allow_methods=["POST", "OPTIONS"],
    allow_headers=["Content-Type"],
    max_age=600,
)

# Prevent duplicate writes within this application process.
lead_lock = asyncio.Lock()


class LeadRequest(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")

    name: Annotated[str, Field(min_length=1, max_length=120)]
    email: EmailStr
    phone: Annotated[str, Field(min_length=5, max_length=30)]
    property_code: Annotated[str, Field(min_length=1, max_length=64)]
    message: Annotated[str, Field(min_length=1, max_length=3000)]
    consent: bool

    @field_validator("phone")
    @classmethod
    def validate_phone(cls, value: str) -> str:
        if not re.fullmatch(r"[+0-9() .-]{5,30}", value):
            raise ValueError("Phone number contains unsupported characters")
        return value

    @field_validator("property_code")
    @classmethod
    def validate_property_code(cls, value: str) -> str:
        if not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", value):
            raise ValueError("Invalid property code")
        return value


def canonical_lead(lead: LeadRequest) -> dict[str, str | bool]:
    """Normalize fields used for deterministic lead deduplication."""
    return {
        "name": lead.name.casefold(),
        "email": str(lead.email).strip().casefold(),
        "phone": re.sub(r"\D", "", lead.phone),
        "property_code": lead.property_code.strip().upper(),
        "message": lead.message.strip(),
        "consent": lead.consent,
    }


def lead_hash(lead: LeadRequest) -> str:
    serialized = json.dumps(
        canonical_lead(lead), sort_keys=True, separators=(",", ":"), ensure_ascii=False
    )
    return hashlib.sha256(serialized.encode("utf-8")).hexdigest()


def read_existing_hashes() -> set[str]:
    hashes: set[str] = set()
    if not LEADS_FILE.exists():
        return hashes

    with LEADS_FILE.open("r", encoding="utf-8") as file:
        for line in file:
            try:
                entry = json.loads(line)
                value = entry.get("deduplication_hash")
                if isinstance(value, str):
                    hashes.add(value)
            except (json.JSONDecodeError, AttributeError):
                # Ignore malformed lines rather than failing every new submission.
                continue
    return hashes


def append_record(record: dict) -> None:
    LEADS_FILE.parent.mkdir(parents=True, exist_ok=True)
    file_is_new = not LEADS_FILE.exists()

    with LEADS_FILE.open("a", encoding="utf-8") as file:
        file.write(json.dumps(record, ensure_ascii=False) + "\n")
        file.flush()
        os.fsync(file.fileno())

    # Restrict local record permissions where supported.
    if file_is_new:
        try:
            LEADS_FILE.chmod(0o600)
        except OSError:
            pass


async def send_telegram_alert(lead: LeadRequest, digest: str) -> None:
    if not TELEGRAM_BOT_TOKEN or not TELEGRAM_CHAT_ID:
        raise HTTPException(
            status_code=503,
            detail="Lead notification service is not configured",
        )

    text = (
        "New real estate lead\n"
        f"Name: {lead.name}\n"
        f"Email: {lead.email}\n"
        f"Customer phone: {lead.phone}\n"
        f"Property: {lead.property_code}\n"
        f"Message: {lead.message}\n"
        f"Deduplication ID: {digest}"
    )
    endpoint = f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendMessage"

    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.post(
                endpoint,
                json={"chat_id": TELEGRAM_CHAT_ID, "text": text},
            )
            response.raise_for_status()
            payload = response.json()
            if payload.get("ok") is not True:
                raise RuntimeError("Telegram API rejected the message")
    except (httpx.HTTPError, ValueError, RuntimeError) as exc:
        # Keep credentials and upstream response details out of client errors.
        raise HTTPException(
            status_code=502,
            detail="Could not deliver the lead notification",
        ) from exc


@app.post("/api/leads")
async def create_lead(lead: LeadRequest) -> dict[str, str | bool]:
    if not lead.consent:
        raise HTTPException(
            status_code=400,
            detail="Consent is required to submit this lead",
        )

    digest = lead_hash(lead)

    async with lead_lock:
        existing_hashes = read_existing_hashes()
        if digest not in existing_hashes:
            await send_telegram_alert(lead, digest)

            record = {
                "created_at": datetime.now(timezone.utc).isoformat(),
                "deduplication_hash": digest,
                "lead": lead.model_dump(mode="json"),
            }
            try:
                append_record(record)
            except OSError as exc:
                # The alert may already have been delivered; do not expose file details.
                raise HTTPException(
                    status_code=500,
                    detail="Lead was notified but could not be recorded",
                ) from exc

    return {
        "success": True,
        "call_url": f"tel:{BROKER_PHONE}",
        "telegram_url": BROKER_TELEGRAM_URL,
    }


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}
