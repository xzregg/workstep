"""Make ncurses data portable to case-insensitive mounted HOME directories."""

from pathlib import Path
import shutil
import sys


def prepare_terminfo(runtime: Path) -> None:
    for source in runtime.glob("python/*/share/terminfo"):
        portable = source.with_name("terminfo-portable")
        portable.mkdir()
        for group in source.iterdir():
            if not group.is_dir():
                continue
            for entry in group.iterdir():
                # ncurses supports hexadecimal buckets, avoiding N/n collisions.
                target = portable / format(ord(entry.name[0]), "x") / entry.name
                target.parent.mkdir(exist_ok=True)
                shutil.copyfile(entry, target)
        shutil.rmtree(source)
        portable.rename(source)


if __name__ == "__main__":
    prepare_terminfo(Path(sys.argv[1]))
