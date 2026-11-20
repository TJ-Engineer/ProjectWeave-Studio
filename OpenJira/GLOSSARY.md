# OpenJira Issue Management

This glossary defines the domain language used to plan and deliver work in OpenJira.

## Language

**Completion Action (COA)**:
An ordered checklist item owned by a Story that describes one action required before the Story can be completed. Each COA is represented by exactly one generated COA Task.
_Avoid_: Acceptance criterion, subtask, checklist task

**Generated COA Task**:
A normal Task issue linked one-to-one to a Completion Action. Its workflow state is the durable completion state shown by the COA checkbox.
_Avoid_: Child task, subtask
