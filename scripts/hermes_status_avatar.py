#!/usr/bin/env python3
"""Validate and resize one remotely delivered Hermes status avatar; never generates images."""
from __future__ import annotations

import argparse
import hashlib
import pathlib
import sys

DELIVERED_SIZE = (256, 256)
DEFAULT_OUTPUT_DIR = pathlib.Path("/clawd-media/generated/hermes-status")
PUBLIC_PREFIX = "/media/generated/hermes-status"


def safe_output_name(event_id: str) -> str:
    return hashlib.sha256(event_id.encode("utf-8")).hexdigest()[:24] + ".png"


def deliver_avatar(
    source: pathlib.Path,
    event_id: str,
    output_dir: pathlib.Path = DEFAULT_OUTPUT_DIR,
    allowed_root: pathlib.Path = pathlib.Path("/clawd-media/generated"),
) -> str:
    """Resize a delivered remote asset to 256px inside the allowed generated-media subtree."""
    from PIL import Image

    source = source.resolve(strict=True)
    output_dir = output_dir.resolve()
    allowed_root = allowed_root.resolve()
    if output_dir != allowed_root and allowed_root not in output_dir.parents:
        raise ValueError("output directory is outside /clawd-media/generated")
    output_dir.mkdir(mode=0o750, parents=True, exist_ok=True)
    destination = output_dir / safe_output_name(event_id)
    temporary = destination.with_suffix(".tmp.png")
    lanczos = getattr(getattr(Image, "Resampling", Image), "LANCZOS")
    with Image.open(source) as image:
        image.convert("RGB").resize(DELIVERED_SIZE, lanczos).save(
            temporary, format="PNG", optimize=True
        )
    temporary.replace(destination)
    return f"{PUBLIC_PREFIX}/{destination.name}"


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", required=True, help="local MEDIA path returned by the single remote image_generate call")
    parser.add_argument("--event-id", required=True)
    parser.add_argument("--output-dir", type=pathlib.Path, default=DEFAULT_OUTPUT_DIR)
    args = parser.parse_args(argv)
    try:
        print(deliver_avatar(pathlib.Path(args.source), args.event_id, args.output_dir))
        return 0
    except Exception as error:
        print(f"avatar unavailable: {type(error).__name__}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
