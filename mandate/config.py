import os

try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:  # pragma: no cover
    pass

MONGODB_URI = os.getenv("MONGODB_URI", "mongodb://localhost:27017")
DB_NAME = os.getenv("MONGODB_DB", "mandate")

COMMERCE_URL = os.getenv("COMMERCE_URL", "http://127.0.0.1:8100").rstrip("/")
PSP_URL = f"{COMMERCE_URL}/psp"
MERCHANTS = ["northdesk", "pixelmart", "grayline"]


def merchant_url(merchant_id: str) -> str:
    return f"{COMMERCE_URL}/merchants/{merchant_id}"


ACP_API_VERSION = "2026-04-17"
ANTHROPIC_MODEL = os.getenv("ANTHROPIC_MODEL", "claude-sonnet-5-5")
AGENT_ID = "procurement-agent"
