"""The verification report: error/warning/log buckets and pass/fail logic."""


class Report:
    """Accumulates verification findings and renders the JSON report.

    `passed` is True only when the extension loaded and no errors were recorded. Coverage
    failures and runtime errors both land in `errors`, so either fails verification.
    """

    def __init__(self):
        self.chrome_version: str | None = None
        self.extension_id: str | None = None
        self.loaded: bool = False
        self.errors: list[dict] = []
        self.warnings: list[dict] = []
        self.logs: list[dict] = []
        self.dropped_namespaces: list[dict] = []

    def error(self, source: str, text) -> None:
        if text:
            self.errors.append({"source": source, "text": str(text)})

    def warn(self, source: str, text) -> None:
        if text:
            self.warnings.append({"source": source, "text": str(text)})

    def log(self, source: str, text) -> None:
        if text:
            self.logs.append({"source": source, "text": str(text)})

    @property
    def passed(self) -> bool:
        return self.loaded and not self.errors

    def to_dict(self) -> dict:
        return {
            "chromeVersion": self.chrome_version,
            "extensionId": self.extension_id,
            "loaded": self.loaded,
            "errors": self.errors,
            "warnings": self.warnings,
            "logs": self.logs,
            "droppedNamespaces": self.dropped_namespaces,
        }
