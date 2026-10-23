# Agent rules

Do not commit or distribute CSV files, proprietary datasets or bulk exports in any format. Do not repackage withdrawn rows as JSON, images, Markdown or XLSX. A CSV for Jay needs his explicit approval after inspecting its exact contents. Existing tooling may read an operator's authorized private input; do not create sample CSVs automatically.

Use native fictional test dictionaries and mocked I/O without generating a CSV file or serializing a CSV sample. Preserve CLI/private-input behavior and test coverage; do not hide unresolved coverage or tool failures.

Follow CONTRIBUTING.md: validate and run deterministic plugin tests, bump the plugin version and record changes. Paid model evals are a separate operation and are not a substitute for deterministic tests.
