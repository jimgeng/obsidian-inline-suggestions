---
name: conventional-commits
description: Write commit messages following the project's Conventional Commits convention. Use when creating, editing, or reviewing Git commit messages.
---

# Conventional commits

Use this convention whenever creating, editing, or reviewing a commit message.

## Format

A commit message MUST begin with this prefix:

```text
<type>[optional scope][!]: <description>
```

- The type is a noun. Prefer `feat` for a new feature, `fix` for a bug fix, `chore` for maintenance, and `doc` for documentation changes. Other suitable types may be used VERY sparingly (if the current four are not sufficient).
- A scope is optional; when useful, use a concise noun describing the affected codebase section in parentheses, for example `fix(parser): ...`.
- Add `!` immediately before the colon to mark a breaking change in the prefix, for example `feat(api)!: ...`.
- The colon and following space are REQUIRED. Put a short summary immediately after them.
- Message components are case-insensitive, except the breaking-change footer token, which MUST be uppercase.

## Body and footers

A longer body is optional and MUST be separated from the description by one blank line. It may contain free-form context and multiple paragraphs.

Footers are optional and MUST be separated from the body (or description, if there is no body) by one blank line. Each footer uses a token followed by `: ` or ` #` and a value, for example `Refs: #42` or `Reviewed-by: Name`. Use hyphens instead of spaces in footer tokens, except for the special breaking-change token. Footer values may span lines; a subsequent valid footer token/separator starts the next footer.

Indicate breaking changes either with `!` in the prefix or with a footer such as:

```text
BREAKING CHANGE: description of the breaking change
```

`BREAKING-CHANGE` is synonymous with `BREAKING CHANGE` as a footer token. When `!` is present, the breaking-change footer is optional; the description should explain the breaking change.

## Examples

```text
feat: add inline completion
fix(editor): preserve cursor position
chore!: drop support for the old configuration format

doc: explain setup

BREAKING CHANGE: configuration keys have been renamed
```
