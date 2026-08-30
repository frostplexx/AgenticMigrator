#!/usr/bin/env python3
"""Render a pi transcript.jsonl file as readable plain text."""

import argparse
import json
import os
import re
import sys

try:
    import tiktoken
except ImportError:
    sys.exit(
        "render_transcript: tiktoken is required for token decoding.\n"
        "Run the script with uv so the dependency installs automatically:\n"
        "  uv run render_transcript.py [file]\n"
        "Alternatively, install tiktoken into the current environment first."
    )


class TokenDecoder:
    """Resolve token IDs found in transcript error text to their decoded form."""

    def __init__(self, enabled: bool):
        self.enabled = enabled
        self.specials = {}
        self.encoding = None
        self.limit = 0
        if not enabled:
            return
        # gpt-oss-120b registers its special tokens; o200k_base covers base tokens.
        for name in ("gpt-oss-120b", "gpt-oss", "o200k_base"):
            try:
                if name == "o200k_base":
                    enc = tiktoken.get_encoding(name)
                else:
                    enc = tiktoken.encoding_for_model(name)
            except Exception:
                continue
            try:
                self.specials.update({v: k for k, v in enc._special_tokens.items()})
            except AttributeError:
                pass
            self.encoding = enc
            self.limit = enc.n_vocab
            break

    def label(self, token_id: int):
        if token_id in self.specials:
            return self.specials[token_id]
        if self.encoding is not None and 0 <= token_id < self.encoding.n_vocab:
            try:
                return self.encoding.decode([token_id])
            except Exception:
                return None
        return None

    def annotate(self, text: str) -> str:
        """Append the decoded token text after any token IDs in the text."""

        def repl(match):
            token_id = int(match.group(0))
            if token_id > self.limit:
                return match.group(0)
            decoded = self.label(token_id)
            if decoded is None:
                return match.group(0)
            return f"{token_id} ({decoded!r})"

        if not self.enabled:
            return text
        return re.sub(r"\b\d{5,7}\b", repl, text)


class Style:
    """ANSI styles, disabled when output is not a TTY or --no-color is set."""

    def __init__(self, enabled: bool):
        self.enabled = enabled

    def paint(self, text: str, code: str) -> str:
        if not self.enabled:
            return text
        return f"\033[{code}m{text}\033[0m"

    def header(self, text: str) -> str:
        return self.paint(text, "1;36")

    def dim(self, text: str) -> str:
        return self.paint(text, "2")

    def thinking(self, text: str) -> str:
        return self.paint(text, "2;3;90")

    def tool(self, text: str) -> str:
        return self.paint(text, "33")

    def user(self, text: str) -> str:
        return self.paint(text, "1;32")

    def assistant(self, text: str) -> str:
        return self.paint(text, "1;34")

    def error(self, text: str) -> str:
        return self.paint(text, "1;31")

    def rule(self, width: int = 60) -> str:
        return self.dim("-" * width)


def load_records(path: str):
    records = []
    with open(path, "r", encoding="utf-8") as fh:
        for lineno, line in enumerate(fh, 1):
            line = line.strip()
            if not line:
                continue
            try:
                records.append(json.loads(line))
            except json.JSONDecodeError as exc:
                print(
                    f"render_transcript: skipping invalid JSON on line {lineno}: {exc}",
                    file=sys.stderr,
                )
    return records


def format_args(arguments) -> str:
    """Render tool arguments compactly, tolerating object or JSON-string form."""
    if isinstance(arguments, str):
        try:
            arguments = json.loads(arguments)
        except json.JSONDecodeError:
            return arguments
    return json.dumps(arguments, ensure_ascii=False)


def render_message(rec: dict, style: Style, decoder: TokenDecoder) -> None:
    msg = rec.get("message", {})
    role = msg.get("role", "?")
    stamp = rec.get("timestamp", "")
    tag = "USER" if role == "user" else "ASSISTANT"
    label = style.user(tag) if role == "user" else style.assistant(tag)
    print(f"\n{style.header(f'[{stamp}]')} {label}")
    print(style.rule())

    content = msg.get("content") or []
    for block in content:
        btype = block.get("type")
        if btype == "text":
            print(block.get("text", ""))
        elif btype == "thinking":
            text = block.get("thinking") or block.get("text") or ""
            for line in text.splitlines():
                print(style.thinking(f"\u25b3 {line}"))
            print()
        elif btype == "toolCall":
            name = block.get("name", "?")
            args = format_args(block.get("arguments", {}))
            print(style.tool(f"\U0001f527 {name}({args})"))
        elif btype == "toolResult":
            result = block.get("result", "")
            if isinstance(result, (dict, list)):
                result = json.dumps(result, ensure_ascii=False)
            if result:
                print(style.dim("\u21b3"))
                for line in str(result).splitlines():
                    print(style.dim(f"  {decoder.annotate(line)}"))
        else:
            print(style.dim(f"[{btype}]"))
            print(style.dim(json.dumps(block, ensure_ascii=False)))

    # Auxiliary message metadata worth showing.
    if msg.get("errorMessage"):
        print(style.error(f"\u2715 {decoder.annotate(msg['errorMessage'])}"))
    if msg.get("stopReason") and msg["stopReason"] != "stop":
        print(style.dim(f"stop reason: {msg['stopReason']}"))


def render_simple(rec: dict, style: Style) -> None:
    rtype = rec.get("type")
    stamp = rec.get("timestamp", "")
    prefix = style.header(f"[{stamp}]")
    if rtype == "session":
        print(f"{prefix} session v{rec.get('version')}  cwd={rec.get('cwd')}")
    elif rtype == "model_change":
        print(f"{prefix} model: {rec.get('provider')}/{rec.get('modelId')}")
    elif rtype == "thinking_level_change":
        print(f"{prefix} thinking level: {rec.get('thinkingLevel')}")
    else:
        print(f"{prefix} {rtype}: {json.dumps(rec, ensure_ascii=False)}")


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        description="Render a pi transcript.jsonl file as readable text."
    )
    parser.add_argument("file", nargs="?", default="transcript.jsonl",
                        help="transcript file to render (default: transcript.jsonl)")
    parser.add_argument("--no-color", action="store_true",
                        help="disable ANSI colors")
    parser.add_argument("--no-token-decode", action="store_true",
                        help="do not annotate token IDs with decoded text")
    args = parser.parse_args(argv)

    if not os.path.isfile(args.file):
        print(f"render_transcript: file not found: {args.file}", file=sys.stderr)
        return 1

    color = args.no_color or not sys.stdout.isatty() or os.environ.get("NO_COLOR")
    style = Style(enabled=not color)
    decoder = TokenDecoder(enabled=not args.no_token_decode)

    first = True
    for rec in load_records(args.file):
        if not first:
            print()
        first = False
        rtype = rec.get("type")
        if rtype == "message":
            render_message(rec, style, decoder)
        else:
            render_simple(rec, style)
    return 0


if __name__ == "__main__":
    sys.exit(main())