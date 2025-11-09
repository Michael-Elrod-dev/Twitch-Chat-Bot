#!/usr/bin/env python3
"""
Pre-commit hook to check and auto-fix JavaScript file path headers.

Expected format:

// src/bot.js

<code here>
"""

import sys


def fix_file_header(filepath):
    """
    Check and auto-fix the file header format.

    Expected:
    - Line 1: // <relative-path-to-file>
    - Line 2: <blank line>

    Returns True if file was already valid, False if it was fixed.
    """
    # Get the relative path from the project root
    # The file path passed to pre-commit is already relative to the repo root
    expected_path = filepath.replace('\\', '/')
    expected_comment = f"// {expected_path}"

    try:
        with open(filepath, 'r', encoding='utf-8') as f:
            lines = f.readlines()
    except Exception as e:
        print(f"❌ Error reading {filepath}: {e}")
        return True  # Don't try to fix if we can't read

    needs_fix = False

    # Check if file is empty or too short
    if len(lines) == 0:
        # Empty file - add header
        lines = [expected_comment + '\n', '\n']
        needs_fix = True
        print(f"✅ {filepath}: Added header to empty file")
    else:
        # Check first line
        first_line = lines[0].rstrip()

        if not first_line.startswith('//'):
            # No comment at all - insert header at the beginning
            lines.insert(0, expected_comment + '\n')
            lines.insert(1, '\n')
            needs_fix = True
            print(f"✅ {filepath}: Added missing header comment")
        elif first_line != expected_comment:
            # Wrong path in comment - fix it
            lines[0] = expected_comment + '\n'
            needs_fix = True
            print(f"✅ {filepath}: Fixed header path")
            print(f"   Was: {first_line}")
            print(f"   Now: {expected_comment}")

        # Check second line (after fixing first line if needed)
        if len(lines) < 2:
            # No second line - add blank line
            lines.insert(1, '\n')
            needs_fix = True
            print(f"✅ {filepath}: Added missing blank line after header")
        elif lines[1].rstrip() != "":
            # Second line is not blank - insert a blank line
            lines.insert(1, '\n')
            needs_fix = True
            print(f"✅ {filepath}: Added blank line after header")

    # Write back if changes were made
    if needs_fix:
        try:
            with open(filepath, 'w', encoding='utf-8') as f:
                f.writelines(lines)
        except Exception as e:
            print(f"❌ Error writing {filepath}: {e}")
            return True

        return False  # File was fixed (return False = hook "failed" to trigger re-staging)

    return True  # File was already valid


def main():
    """Main entry point for the hook."""
    if len(sys.argv) < 2:
        print("No files to check")
        return 0

    files_to_check = sys.argv[1:]
    all_valid = True

    for filepath in files_to_check:
        # Skip node_modules and other common directories
        if 'node_modules' in filepath or '.git' in filepath:
            continue

        if not fix_file_header(filepath):
            all_valid = False

    if not all_valid:
        print("\n✨ Files were automatically fixed! Run git add to stage the changes.")
        return 1

    return 0


if __name__ == '__main__':
    sys.exit(main())
