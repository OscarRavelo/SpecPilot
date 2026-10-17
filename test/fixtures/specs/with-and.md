---
id: TASK-102
type: endpoint-fields
---
# Update phone number on PUT /users/:id

## Acceptance criteria

### AC-1: Sets a phone number on a user that had none
- Given a user with id 42 exists
- And their phone_number is null
- When I send PUT /users/42 with body {"phone_number": "+34623234321"}
- Then the response status is 200
- And the user with id 42 has phone_number "+34623234321"
