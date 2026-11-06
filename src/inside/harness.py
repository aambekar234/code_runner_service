"""Runs one job inside the sandbox and reports each result through `emit`, as a JSON string.

`run_python` loads the solution once and calls its function per case, so module-level state
carries over between the cases of one run. `run_sql` runs the script on a fresh database per
dataset. Both return the job's outcome as a JSON string. Nothing here judges.
"""

import contextlib
import io
import json
import re
import sqlite3
import time
import traceback

SOLUTION_FILE = "solution.py"
# JSON numbers reach JavaScript as doubles, which hold integers exactly only up to here.
MAX_SAFE_INT = 2**53 - 1
COMMENTS = re.compile(r"--[^\n]*|/\*.*?\*/", re.DOTALL)


def run_python(job_json, emit):
    job = json.loads(job_json)
    namespace = {"__name__": "solution"}
    try:
        exec(compile(job["code"], SOLUTION_FILE, "exec"), namespace)
    except BaseException as error:  # SystemExit and the like are the solution's errors too
        return outcome("error", describe(error))
    function = namespace.get(job["entry"])
    if not callable(function):
        return outcome("error", f"the code defines no function named {job['entry']!r}")
    for case in job["cases"]:
        result = run_case(function, case, job["limits"])
        emit(fitted(result, job["limits"], {"output": None, "stdout": ""}))
    return outcome("ok")


def run_case(function, case, limits):
    printed = CappedText(limits["stdout_chars"])
    output, error = None, None
    start = time.perf_counter()
    try:
        with contextlib.redirect_stdout(printed):
            output = function(*case["args"])
    except BaseException as raised:
        error = describe(raised)
    duration = time.perf_counter() - start
    if error is None:
        error = json_problem(output)
    return {
        "id": case["id"],
        "output": None if error else output,
        "error": error,
        "stdout": printed.text(),
        "duration_seconds": round(duration, 6),
    }


def run_sql(job_json, emit):
    job = json.loads(job_json)
    statements = split_statements(job["code"])
    if not statements:
        return outcome("error", "the code holds no SQL statements")
    for dataset in job["datasets"]:
        result = run_dataset(statements, dataset, job["limits"])
        emit(fitted(result, job["limits"], {"statements": [], "check": None}))
    return outcome("ok")


def run_dataset(statements, dataset, limits):
    start = time.perf_counter()
    with contextlib.closing(sqlite3.connect(":memory:", autocommit=True)) as db:
        ran, check, error = run_script(db, statements, dataset, limits)
    return {
        "id": dataset["id"],
        "statements": ran,
        "check": check,
        "error": error,
        "duration_seconds": round(time.perf_counter() - start, 6),
    }


def run_script(db, statements, dataset, limits):
    """Setup, the statements, then the check: what ran, what the check read, and what stopped it."""
    ran = []
    try:
        db.executescript(dataset["setup"])
    except Exception as error:
        return ran, None, f"the dataset's setup failed: {describe(error)}"
    for number, sql in enumerate(statements, start=1):
        try:
            cursor = db.execute(sql)
            rows = read_rows(cursor, limits)
        except Exception as error:  # MemoryError included: every error here is the statement's
            return ran, None, f"statement {number}: {describe(error)}"
        ran.append({"sql": sql, **rows, "rows_changed": max(cursor.rowcount, 0)})
    if not dataset.get("check"):
        return ran, None, None
    try:
        return ran, read_rows(db.execute(dataset["check"]), limits), None
    except Exception as error:
        return ran, None, f"the check query failed: {describe(error)}"


def read_rows(cursor, limits):
    columns = [column[0] for column in cursor.description or []]
    rows = [list(row) for row in cursor.fetchmany(limits["rows"] + 1)]
    if len(rows) > limits["rows"]:
        raise ValueError(f"returned more than {limits['rows']} rows")
    problem = json_problem(rows)
    if problem:
        raise ValueError(problem)
    return {"columns": columns, "rows": rows}


def split_statements(script):
    """The script's statements in order, cut wherever SQLite sees a complete statement."""
    pieces, start = [], 0
    for end, char in enumerate(script):
        if char == ";" and sqlite3.complete_statement(script[start : end + 1]):
            pieces.append(script[start : end + 1].strip())
            start = end + 1
    pieces.append(script[start:].strip())
    return [piece for piece in pieces if COMMENTS.sub("", piece).strip(" \t\r\n;")]


def json_problem(value):
    """Why the value can't go back as JSON, or None when it can."""
    try:
        json.dumps(value, allow_nan=False)
        unsafe = has_unsafe_int(value)
    except Exception as error:
        return f"returned a value that is not plain JSON data: {describe(error)}"
    if unsafe:
        return f"returned an integer beyond ±{MAX_SAFE_INT}; return it as a string"
    return None


def has_unsafe_int(value):
    if isinstance(value, bool):
        return False
    if isinstance(value, int):
        return abs(value) > MAX_SAFE_INT
    if isinstance(value, list):
        return any(has_unsafe_int(item) for item in value)
    if isinstance(value, dict):
        return any(has_unsafe_int(item) for item in value.values())
    return False


def fitted(result, limits, emptied):
    """The result as JSON, or, past the size limit, the result with `emptied` and an error."""
    text = json.dumps(result)  # ASCII, so its length is its size in bytes
    if len(text) > limits["result_bytes"]:
        error = f"the result is larger than {limits['result_bytes']} bytes of JSON"
        text = json.dumps({**result, **emptied, "error": error})
    return text


def describe(error):
    """`Type: message`, with the line of the solution it came from when there is one."""
    try:
        message = error.msg if isinstance(error, SyntaxError) else str(error)
    except Exception:  # a solution's own exception class can break its __str__
        message = ""
    text = f"{type(error).__name__}: {message}" if message else type(error).__name__
    frames = traceback.extract_tb(error.__traceback__)
    lines = [frame.lineno for frame in frames if frame.filename == SOLUTION_FILE]
    if isinstance(error, SyntaxError) and error.filename == SOLUTION_FILE:
        lines.append(error.lineno)
    return f"{text} (line {lines[-1]})" if lines else text


def outcome(status, error=None):
    return json.dumps({"status": status, "error": error})


class CappedText(io.TextIOBase):
    """Printed text, kept up to a limit."""

    def __init__(self, limit):
        self.limit = limit
        self.parts = []
        self.size = 0
        self.cut = False

    def write(self, text):
        if not isinstance(text, str):
            raise TypeError(f"write() argument must be str, not {type(text).__name__}")
        room = self.limit - self.size
        if len(text) > room:
            self.cut = True
        kept = text[: max(room, 0)]
        self.parts.append(kept)
        self.size += len(kept)
        return len(text)

    def text(self):
        return "".join(self.parts) + ("\n[output cut off]" if self.cut else "")
