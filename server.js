const express = require('express');
global.FormData = require('form-data');
const Librus = require('librus-api');
const cors = require('cors');
const crypto = require('crypto');

const app = express();
app.use(express.json());
app.use(cors({ origin: true }));

const SESSION_TTL = 60 * 60 * 1000;
const PORT = process.env.PORT || 3000;

// In-memory session store: Maps sessionToken -> { client, expiresAt, username }
const sessions = new Map();

// 1. Login Endpoint
app.post('/api/login', async (req, res) => {
    const { username, password } = req.body || {};
    
    if (!username || !password) {
        return res.status(400).json({ error: "Username and password are required" });
    }

    try {
        let client = new Librus();
        await client.authorize(username, password);
        
        const sessionToken = crypto.randomBytes(32).toString('hex');
        
        sessions.set(sessionToken, {
            client,
            username,
            expiresAt: Date.now() + SESSION_TTL,
            notificationSnapshot: null
        });

        res.json({ success: true, token: sessionToken, username, expiresAt: Date.now() + SESSION_TTL });
    } catch (error) {
        console.error('Librus login failed:', error.message);
        res.status(401).json({ success: false, error: "Authentication failed or Librus is unavailable" });
    }
});

// Middleware to secure endpoints
function requireAuth(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token || !sessions.has(token)) {
        return res.status(401).json({ error: "Unauthorized or invalid session" });
    }

    const session = sessions.get(token);
    if (Date.now() > session.expiresAt) {
        sessions.delete(token);
        return res.status(401).json({ error: "Session expired, please log in again" });
    }

    req.librusClient = session.client;
    req.authToken = token;
    next();
}

function asyncEndpoint(handler) {
    return async (req, res) => {
        try {
            const data = await handler(req);
            res.json({ success: true, data });
        } catch (error) {
            console.error(`API ${req.method} ${req.path} failed:`, error.message);
            res.status(502).json({ success: false, error: error.message || 'Librus request failed' });
        }
    };
}

app.get('/api/health', (req, res) => {
    res.json({ success: true, service: 'librus-api', time: new Date().toISOString() });
});

app.get('/api/session', requireAuth, asyncEndpoint(async (req) => ({
    username: sessions.get(req.authToken).username,
    expiresAt: sessions.get(req.authToken).expiresAt
})));

app.post('/api/logout', requireAuth, (req, res) => {
    sessions.delete(req.authToken);
    res.json({ success: true });
});

function itemKey(item, fallback) {
    return String(item && (item.id ?? item.title ?? item.name ?? item.date) || fallback);
}

function timetableSnapshot(timetable) {
    return Object.entries(timetable && timetable.table || {}).flatMap(([day, lessons]) =>
        (lessons || []).map((lesson, index) => lesson && {
            key: `${day}:${index}`,
            day,
            subject: lesson.subject || '',
            teacher: lesson.teacher || '',
            room: lesson.room || '',
            time: lesson.time || ''
        }).filter(Boolean)
    );
}

function addedItems(current, previous, keyFn) {
    const oldKeys = new Set((previous || []).map(keyFn));
    return (current || []).filter(item => !oldKeys.has(keyFn(item)));
}

function changedLessons(current, previous) {
    const oldLessons = new Map((previous || []).map(lesson => [lesson.key, lesson]));
    return (current || []).filter(lesson => {
        const old = oldLessons.get(lesson.key);
        return old && ['subject', 'teacher', 'room', 'time'].some(field => old[field] !== lesson[field]);
    }).map(lesson => ({
        ...lesson,
        previous: oldLessons.get(lesson.key)
    }));
}

async function listInboxMessages(client, requestedFolder) {
    const folderId = Number(requestedFolder) || 5;
    const messages = await client.inbox.listInbox(folderId);
    if (messages.length || requestedFolder) return { folderId, messages };
    return { folderId: 1, messages: await client.inbox.listInbox(1) };
}

async function getInboxMessagesWithContent(client, requestedFolder) {
    const { folderId, messages } = await listInboxMessages(client, requestedFolder);
    return Promise.all(messages.map(async (message) => {
        try {
            const detail = await client.inbox.getMessage(folderId, message.id);
            return { ...message, ...detail, user: detail.user || message.user || '' };
        } catch (error) {
            return {
                ...message,
                content: '',
                detailError: 'Message preview could not be loaded'
            };
        }
    }));
}

function messagePerson(value) {
    if (Array.isArray(value)) return value.map(messagePerson).filter(Boolean).join(', ');
    if (!value || typeof value !== 'object') return value ? String(value) : '';
    return value.name || value.user || value.displayName || value.nameSurname || value.login || '';
}

function sentMessageRecipient(message) {
    return messagePerson(
        message.recipient || message.recipients || message.receiver || message.receivers ||
        message.to || message.recipientName || message.receiverName || message.user
    );
}

async function getSentMessagesWithRecipient(client, requestedFolder) {
    const messages = await getInboxMessagesWithContent(client, requestedFolder);
    return messages.map((message) => ({ ...message, recipient: sentMessageRecipient(message) }));
}

async function getSentMessageWithRecipient(client, folderId, messageId) {
    const headers = await client.inbox.listInbox(folderId);
    const header = headers.find((message) => Number(message.id) === Number(messageId)) || {};
    const detail = await client.inbox.getMessage(folderId, messageId);
    const message = { ...header, ...detail, user: detail.user || header.user || '' };
    return { ...message, recipient: sentMessageRecipient(message) };
}

app.get('/api/notifications/latest', requireAuth, asyncEndpoint(async (req) => {
    const [counters, inbox, announcements, calendar, timetable] = await Promise.all([
        req.librusClient.info.getNotifications(),
        listInboxMessages(req.librusClient),
        req.librusClient.inbox.listAnnouncements(),
        req.librusClient.calendar.getCalendar(),
        req.librusClient.calendar.getTimetable()
    ]);
    const snapshot = {
        messages: inbox.messages || [],
        announcements: announcements || [],
        calendar: (calendar || []).flat().filter(Boolean),
        timetable: timetableSnapshot(timetable)
    };
    const session = sessions.get(req.authToken);
    const previous = session.notificationSnapshot;
    session.notificationSnapshot = snapshot;

    return {
        checkedAt: new Date().toISOString(),
        firstCheck: !previous,
        counters,
        changes: previous ? {
            messages: addedItems(snapshot.messages, previous.messages, item => itemKey(item, `${item.user}:${item.date}:${item.title}`)),
            announcements: addedItems(snapshot.announcements, previous.announcements, item => itemKey(item, `${item.user}:${item.date}:${item.title}`)),
            calendar: addedItems(snapshot.calendar, previous.calendar, item => itemKey(item, `${item.day}:${item.title}`)),
            timetableChanged: changedLessons(snapshot.timetable, previous.timetable)
        } : { messages: [], announcements: [], calendar: [], timetableChanged: [] }
    };
}));

// 2. Homework Endpoint
app.get('/api/homework', requireAuth, asyncEndpoint(async (req) => {
    const subjects = await req.librusClient.homework.listSubjects();
    const assignments = await req.librusClient.homework.listHomework(
        req.query.subjectId || -1,
        req.query.from || '',
        req.query.to || ''
    );
    return { subjects, assignments };
}));

app.get('/api/homework/:id', requireAuth, asyncEndpoint((req) =>
    req.librusClient.homework.getHomework(Number(req.params.id))
));

// 3. Inbox Messages Endpoint
app.get('/api/messages', requireAuth, asyncEndpoint((req) =>
    getInboxMessagesWithContent(req.librusClient, req.query.folder || req.query.folderId)
));

app.get('/api/messages/sent', requireAuth, asyncEndpoint((req) =>
    getSentMessagesWithRecipient(req.librusClient, req.query.folder || process.env.LIBRUS_SENT_FOLDER || 6)
));

app.get('/api/messages/sent/:messageId', requireAuth, asyncEndpoint((req) =>
    getSentMessageWithRecipient(req.librusClient, Number(process.env.LIBRUS_SENT_FOLDER || 6), Number(req.params.messageId))
));

app.get('/api/announcements', requireAuth, asyncEndpoint((req) =>
    req.librusClient.inbox.listAnnouncements()
));

app.get('/api/messages/:folderId/:messageId', requireAuth, asyncEndpoint(async (req) =>
    req.librusClient.inbox.getMessage(Number(req.params.folderId), Number(req.params.messageId))
));

app.post('/api/messages', requireAuth, asyncEndpoint(async (req) => {
    const { userIds, title, content } = req.body || {};
    if (!userIds || !title || !content) throw new Error('userIds, title and content are required');
    return req.librusClient.inbox.sendMessage(userIds, title, content);
}));

app.delete('/api/messages/:messageId', requireAuth, asyncEndpoint((req) =>
    req.librusClient.inbox.removeMessage(Number(req.params.messageId))
));

app.get('/api/attachments', requireAuth, async (req, res) => {
    try {
        if (!req.query.path) return res.status(400).json({ success: false, error: 'path is required' });
        const file = await req.librusClient.inbox.getFile(req.query.path);
        res.set('Content-Type', file.headers?.['content-type'] || 'application/octet-stream');
        file.pipe(res);
    } catch (error) {
        console.error('API attachment failed:', error.message);
        res.status(502).json({ success: false, error: error.message || 'Attachment download failed' });
    }
});

app.get('/api/receivers', requireAuth, asyncEndpoint(async (req) =>
    req.librusClient.inbox.listReceivers(Number(req.query.groupId) || 0)
));

// 4. Grades / Marks Endpoint
app.get('/api/grades', requireAuth, asyncEndpoint((req) => req.librusClient.info.getGrades()));

app.get('/api/grades/:id', requireAuth, asyncEndpoint((req) =>
    req.librusClient.info.getGrade(Number(req.params.id))
));

app.get('/api/point-grades/:id', requireAuth, asyncEndpoint((req) =>
    req.librusClient.info.getPointGrade(Number(req.params.id))
));

// 5. Attendance Endpoint
app.get('/api/attendance', requireAuth, asyncEndpoint((req) => req.librusClient.absence.getAbsences()));

app.get('/api/attendance/:id', requireAuth, asyncEndpoint((req) =>
    req.librusClient.absence.getAbsence(Number(req.params.id))
));

// 6. Timetable Endpoint
app.get('/api/timetable', requireAuth, asyncEndpoint((req) =>
    req.librusClient.calendar.getTimetable(req.query.from, req.query.to)
));

app.get('/api/timetable/changes', requireAuth, asyncEndpoint(async (req) => {
    const today = new Date();
    const monday = new Date(today);
    monday.setDate(today.getDate() - ((today.getDay() + 6) % 7));
    const friday = new Date(monday);
    friday.setDate(monday.getDate() + 4);
    const formatDate = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    const from = req.query.from || formatDate(monday);
    const to = req.query.to || formatDate(friday);
    const formData = new FormData();
    formData.append('tydzien', `${from}_${to}`);
    const document = await req.librusClient._request('post', 'przegladaj_plan_lekcji', formData);
    const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];
    const changes = [];

    const parseLesson = (element, removed) => {
        const item = document(element);
        const parts = (item.html() || '').split('<br>');
        const subject = item.find('b').first().text().trim() || item.text().split(/\s+-\s+/)[0].trim();
        const details = (parts[1] || '').replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim().replace(/^[-–]\s*/, '');
        const teacherRoom = details.match(/^(.+?)\s+s\.\s+(.+)$/);
        return {
            subject,
            teacher: teacherRoom ? teacherRoom[1].trim() : details,
            room: teacherRoom ? teacherRoom[2].trim() : '',
            removed
        };
    };

    document('table.decorated.plan-lekcji tbody tr.line1, tr.line1').each((_, row) => {
        const hour = document(row).find('th').text().trim();
        document(row).find('td').slice(1, -1).each((dayIndex, cell) => {
            const entries = [];
            document(cell).find('.text').each((__, element) => {
                const item = document(element);
                const style = `${item.attr('style') || ''} ${item.parent().attr('style') || ''}`.toLowerCase();
                const classes = `${item.attr('class') || ''} ${item.parent().attr('class') || ''}`.toLowerCase();
                const removed = item.closest('s,strike,del').length > 0 || /line-through|removed|deleted|cancel/.test(`${style} ${classes}`);
                entries.push(parseLesson(element, removed));
            });
            const removedContainers = document(cell).find('s,strike,del,.removed,.deleted,[style*="line-through"]');
            removedContainers.each((__, element) => {
                if (!document(element).find('.text').length) entries.push(parseLesson(element, true));
            });
            const uniqueEntries = entries.filter((entry, index, list) => entry.subject && list.findIndex(candidate => candidate.subject === entry.subject && candidate.teacher === entry.teacher && candidate.removed === entry.removed) === index);
            const entriesForCell = uniqueEntries;
            const removed = entriesForCell.filter((entry) => entry.removed);
            const active = entriesForCell.filter((entry) => !entry.removed);
            if (removed.length || active.length > 1) {
                const date = new Date(`${from}T00:00:00`);
                date.setDate(date.getDate() + dayIndex);
                changes.push({ day: days[dayIndex] || `Day ${dayIndex + 1}`, date: formatDate(date), hour, removed, active });
            }
        });
    });
    return { from, to, changes };
}));

app.get('/api/calendar', requireAuth, asyncEndpoint((req) =>
    req.librusClient.calendar.getCalendar(Number(req.query.month), Number(req.query.year))
));

app.get('/api/calendar/:id', requireAuth, asyncEndpoint((req) =>
    req.librusClient.calendar.getEvent(Number(req.params.id))
));

app.get('/api/account', requireAuth, asyncEndpoint((req) => req.librusClient.info.getAccountInfo()));
app.get('/api/lucky-number', requireAuth, asyncEndpoint((req) => req.librusClient.info.getLuckyNumber()));
app.get('/api/notifications', requireAuth, asyncEndpoint((req) => req.librusClient.info.getNotifications()));

if (require.main === module) {
    app.listen(PORT, () => console.log(`Librus API running on port ${PORT}`));
}

module.exports = { app, sessions };