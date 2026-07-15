"""Test configuration."""

import sys
from pathlib import Path

# Add daemon root to path so tests can import main, settings, etc.
sys.path.insert(0, str(Path(__file__).parent.parent))
