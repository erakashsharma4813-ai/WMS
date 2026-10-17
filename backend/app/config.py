from pathlib import Path


BACKEND_DIR = Path(__file__).resolve().parents[1]
PROJECT_ROOT = BACKEND_DIR.parent
DATA_DIR = PROJECT_ROOT / "demo-data" / "automotive-dispatch-demo"


def require_data_file(name: str) -> Path:
    path = DATA_DIR / name
    if not path.is_file():
        raise FileNotFoundError(f"Required demo data file does not exist: {path}")
    return path

