## Base URL

Local development:

```text
http://localhost:3000
```

For a physical phone, `localhost` means the phone itself. Use the computer's LAN IP instead, for example:

```text
http://192.168.1.25:3000
```

The Node server must listen on an address reachable by the phone and the firewall must allow the port.

## Authentication

### `POST /api/login`

Authenticates against Librus and creates a temporary server session.

Request:

```json
{
  "username": "your-librus-login",
  "password": "your-librus-password"
}
```

Success `200`:

```json
{
  "success": true,
  "token": "server-session-token",
  "username": "your-librus-login",
  "expiresAt": 1760000000000
}
```

Store `token` securely on mobile. Do not store the Librus password after login. The current session expires after one hour.

### Authenticated requests

Send the token on every protected request:

```http
Authorization: Bearer server-session-token
```

Protected success responses use this wrapper:

```json
{
  "success": true,
  "data": {}
}
```

Errors use HTTP `401`, `400`, or `502`:

```json
{
  "success": false,
  "error": "Error description"
}
```

## Session and health

### `GET /api/health`

Public server health check.

```json
{
  "success": true,
  "service": "librus-api",
  "time": "2026-09-22T16:32:00.000Z"
}
```

### `GET /api/session`

Returns the current username and session expiration. Requires authentication.

```json
{
  "success": true,
  "data": {
    "username": "your-librus-login",
    "expiresAt": 1760000000000
  }
}
```

### `POST /api/logout`

Invalidates the current session. Requires authentication.

## Notifications

### `GET /api/notifications`

Returns Librus notification counters. These are notification/unread-style counters, not necessarily total records.

```json
{
  "success": true,
  "data": {
    "grades": 0,
    "absence": 0,
    "inbox": 2,
    "announcements": 0,
    "calendar": 15,
    "homework": 1
  }
}
```

### `GET /api/notifications/latest`

Fetches counters and compares the current snapshot with the previous call in this session.

```json
{
  "success": true,
  "data": {
    "checkedAt": "2026-09-22T16:32:00.000Z",
    "firstCheck": false,
    "counters": {},
    "changes": {
      "messages": [],
      "announcements": [],
      "calendar": [],
      "timetableChanged": []
    }
  }
}
```

The first call has empty change arrays because there is no previous snapshot.

## Account

### `GET /api/account`

```json
{
  "success": true,
  "data": {
    "student": {
      "nameSurname": "Student Name",
      "class": "1A",
      "index": "123",
      "educator": "Teacher Name"
    },
    "account": {
      "nameSurname": "Parent or account name",
      "login": "login"
    }
  }
}
```

### `GET /api/lucky-number`

Returns a number or `null`.

```json
{
  "success": true,
  "data": 7
}
```

## Grades

### `GET /api/grades`

Returns one object per subject. A subject contains semester grade arrays.

```json
{
  "success": true,
  "data": [
    {
      "name": "Mathematics",
      "tempAverage": 4.5,
      "average": 4.25,
      "semester": [
        {
          "tempAverage": 4.5,
          "average": 4.25,
          "grades": [
            {
              "id": 123456,
              "value": "5",
              "info": "Test\\nChapter 1"
            }
          ]
        }
      ]
    }
  ]
}
```

The mobile app can count actual grade entries with:

```text
sum(subject.semester[].grades[].length)
```

### `GET /api/grades/:id`

Returns details for one grade:

```json
{
  "grade": "5",
  "category": "Test",
  "date": "2026-09-22",
  "teacher": "Teacher Name",
  "lesson": "Mathematics",
  "inAverage": true,
  "multiplier": "1",
  "user": "Teacher Name",
  "comment": ""
}
```

### `GET /api/point-grades/:id`

Returns the details of a point-based grade. The shape is similar to `/api/grades/:id`, but fields depend on the Librus page.

## Attendance

### `GET /api/attendance`

Returns an object grouped by semester key. Each date row has lesson status entries and summary columns.

```json
{
  "success": true,
  "data": {
    "true": [
      {
        "date": "2026-09-22 (wt.)",
        "table": [
          {
            "type": "nieobecność",
            "id": 987654
          },
          null
        ],
        "info": ["nb0", "1", "1", "0", "0"]
      }
    ],
    "false": []
  }
}
```

`table` can contain `null` placeholders. Always filter them before reading `id` or `type`.

The `info` array is inherited from Librus table columns and is not self-describing in the API. The current UI presents it as totals such as Present, Absent, Excused absence, Late, and Released. Verify the exact column order against the account's Librus page before using it for official statistics.

### `GET /api/attendance/:id`

Returns one absence/attendance detail:

```json
{
  "type": "nieobecność",
  "category": "2026-09-22 (wt.)",
  "date": "Programming mobile applications",
  "subject": "Android Studio environment",
  "lessonHour": "8",
  "teacher": "Teacher Name",
  "trip": false,
  "addedBy": "Teacher Name (Teacher Name) [Nauczyciel]"
}
```

## Timetable

### `GET /api/timetable`

Returns the current week by default. Optional query parameters:

```text
/api/timetable?from=2026-09-22&to=2026-09-26
```

Response:

```json
{
  "success": true,
  "data": {
    "hours": ["1", "2", "3", "4"],
    "table": {
      "Monday": [
        {
          "subject": "Mathematics",
          "teacher": "Teacher Name",
          "room": "12",
          "time": "08:00 - 08:45"
        },
        null
      ],
      "Tuesday": []
    }
  }
}
```

Important: `table[day]` is aligned with `hours` by array index. Do not remove `null` entries before positioning lessons, or lessons will shift into the wrong hour.

### `GET /api/timetable/changes`

Reads the raw timetable HTML for a requested week and attempts to identify removed and replacement lessons.

```text
/api/timetable/changes?from=2026-09-22&to=2026-09-26
```

Response:

```json
{
  "success": true,
  "data": {
    "from": "2026-09-22",
    "to": "2026-09-26",
    "changes": [
      {
        "day": "Tuesday",
        "date": "2026-09-23",
        "hour": "08:00 - 08:45",
        "removed": [
          {
            "subject": "Original subject",
            "teacher": "Original teacher",
            "room": "12",
            "removed": true
          }
        ],
        "active": [
          {
            "subject": "Substitute subject",
            "teacher": "Substitute teacher",
            "room": "18",
            "removed": false
          }
        ]
      }
    ]
  }
}
```

This endpoint depends on how Librus marks changes in its HTML. Some accounts expose only the active substitute, so a client should keep the normal timetable lesson visible and display the returned active lesson as the substitute.

## Calendar

### `GET /api/calendar`

Optional query parameters:

```text
/api/calendar?month=9&year=2026
```

Returns calendar events. Depending on the parser response, events may be nested by day and should be flattened by a mobile client.

Event shape:

```json
{
  "id": 12345,
  "day": "2026-09-22",
  "title": "School event"
}
```

### `GET /api/calendar/:id`

Returns detailed information for one calendar event. The fields depend on Librus and can include date, subject, teacher, type, room, description, and timespan.

## Homework

### `GET /api/homework`

Optional query parameters:

```text
/api/homework?subjectId=-1&from=2026-09-01&to=2026-09-30
```

Response:

```json
{
  "success": true,
  "data": {
    "subjects": [
      { "id": 123, "name": "Mathematics" }
    ],
    "assignments": [
      {
        "id": 456,
        "subject": "Mathematics",
        "user": "Teacher Name",
        "title": "Exercises",
        "type": "Homework",
        "from": "2026-09-22",
        "to": "2026-09-25",
        "status": "not done"
      }
    ]
  }
}
```

### `GET /api/homework/:id`

Returns the detailed homework description, usually including user, title, type, dates, and content.

## Messages

### `GET /api/messages`

Optional folder query:

```text
/api/messages?folder=5
```

The server fetches message headers and attempts to attach full content to every message.

Message fields can include:

```json
{
  "id": 123,
  "folderId": 5,
  "user": "Sender Name",
  "title": "Message title",
  "date": "2026-09-22",
  "read": true,
  "content": "Message body",
  "html": "<p>Message body</p>",
  "files": [
    { "name": "file.pdf", "path": "wiadomosci/..." }
  ]
}
```

### `GET /api/messages/:folderId/:messageId`

Fetches one full message.

### `GET /api/messages/sent`

Fetches sent messages. Each item includes a normalized `recipient` field. The sent folder defaults to `6` and can be changed with `LIBRUS_SENT_FOLDER`.

### `GET /api/messages/sent/:messageId`

Fetches one sent message, including its normalized `recipient` field.

### `POST /api/messages`

Sends a message.

Request:

```json
{
  "userIds": [648158],
  "title": "Hello",
  "content": "Message text"
}
```

`userIds` may contain one or multiple numeric Librus recipient IDs.

### `DELETE /api/messages/:messageId`

Deletes a message by ID.

### `GET /api/receivers?groupId=0`

Returns recipient groups, for example teachers, librarian, secretary, administrators, and parents:

```json
{
  "nauczyciel": [
    { "id": 648158, "user": "Teacher Name", "type": "nauczyciel" }
  ]
}
```

### `GET /api/attachments?path=...`

Streams a message attachment. Pass the attachment `path` URL-encoded. The response is a binary file, not the normal JSON wrapper.

