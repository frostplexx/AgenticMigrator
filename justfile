default:
    @just --list


# Migrate a single extension: just run path/to/extension
run extension:
    @uv run agentictester migrate {{extension}}


# Bulk-migrate a directory of extensions: just batch path/to/corpus 4
batch input workers="2":
    @uv run agentictester batch {{input}} --workers {{workers}}


test:
    @echo not impleemented yet
