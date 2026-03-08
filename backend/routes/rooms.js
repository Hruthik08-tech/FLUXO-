const express = require('express');
const router = express.Router();
const pool = require('../connections/db');

// ═══════════════════════════════════════════════════════════════
// GET /api/rooms — List all business rooms for the org (FR-22)
// ═══════════════════════════════════════════════════════════════
router.get('/', async (req, res) => {
  try {
    const orgId = req.user.org_id;

    const [rows] = await pool.query(
      `SELECT br.*,
              o1.org_name AS org_1_name,
              o2.org_name AS org_2_name,
              (SELECT rm.content FROM room_message rm
               WHERE rm.room_id = br.room_id
               ORDER BY rm.created_at DESC LIMIT 1) AS last_message,
              (SELECT rm.created_at FROM room_message rm
               WHERE rm.room_id = br.room_id
               ORDER BY rm.created_at DESC LIMIT 1) AS last_message_at
       FROM business_room br
       JOIN organisation o1 ON o1.org_id = br.org_id_1
       JOIN organisation o2 ON o2.org_id = br.org_id_2
       WHERE (br.org_id_1 = ? OR br.org_id_2 = ?)
         AND br.deleted_at IS NULL
       ORDER BY br.updated_at DESC`,
      [orgId, orgId]
    );

    // For each room, identify the partner org
    const rooms = rows.map(r => ({
      ...r,
      partner_org_name: r.org_id_1 === orgId ? r.org_2_name : r.org_1_name,
      partner_org_id: r.org_id_1 === orgId ? r.org_id_2 : r.org_id_1
    }));

    res.json(rooms);
  } catch (err) {
    console.error('[Rooms] List error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// ═══════════════════════════════════════════════════════════════
// GET /api/rooms/:id — Get a specific business room
// ═══════════════════════════════════════════════════════════════
router.get('/:id', async (req, res) => {
  try {
    const roomId = req.params.id;
    const orgId = req.user.org_id;

    const [rows] = await pool.query(
      `SELECT br.*,
              o1.org_name AS org_1_name,
              o2.org_name AS org_2_name
       FROM business_room br
       JOIN organisation o1 ON o1.org_id = br.org_id_1
       JOIN organisation o2 ON o2.org_id = br.org_id_2
       WHERE br.room_id = ?
         AND (br.org_id_1 = ? OR br.org_id_2 = ?)
         AND br.deleted_at IS NULL`,
      [roomId, orgId, orgId]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Room not found.' });
    }

    const room = rows[0];
    room.partner_org_name = room.org_id_1 === orgId ? room.org_2_name : room.org_1_name;
    room.partner_org_id = room.org_id_1 === orgId ? room.org_id_2 : room.org_id_1;

    res.json(room);
  } catch (err) {
    console.error('[Rooms] Get error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// ═══════════════════════════════════════════════════════════════
// GET /api/rooms/:id/messages — Get messages (FR-23)
// ═══════════════════════════════════════════════════════════════
router.get('/:id/messages', async (req, res) => {
  try {
    const roomId = req.params.id;
    const orgId = req.user.org_id;

    // Verify membership
    const [room] = await pool.query(
      `SELECT room_id FROM business_room
       WHERE room_id = ? AND (org_id_1 = ? OR org_id_2 = ?) AND deleted_at IS NULL`,
      [roomId, orgId, orgId]
    );
    if (room.length === 0) {
      return res.status(404).json({ error: 'Room not found.' });
    }

    const [messages] = await pool.query(
      `SELECT rm.*, o.org_name AS sender_name
       FROM room_message rm
       JOIN organisation o ON o.org_id = rm.sender_org_id
       WHERE rm.room_id = ?
       ORDER BY rm.created_at ASC`,
      [roomId]
    );

    res.json(messages);
  } catch (err) {
    console.error('[Rooms] Messages error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// ═══════════════════════════════════════════════════════════════
// POST /api/rooms/:id/messages — Send a message (FR-23)
// ═══════════════════════════════════════════════════════════════
router.post('/:id/messages', async (req, res) => {
  try {
    const roomId = req.params.id;
    const orgId = req.user.org_id;
    const { content } = req.body;

    if (!content || !content.trim()) {
      return res.status(400).json({ error: 'Message content is required.' });
    }

    // Verify membership
    const [room] = await pool.query(
      `SELECT * FROM business_room
       WHERE room_id = ? AND (org_id_1 = ? OR org_id_2 = ?) AND deleted_at IS NULL`,
      [roomId, orgId, orgId]
    );
    if (room.length === 0) {
      return res.status(404).json({ error: 'Room not found.' });
    }

    const roomData = room[0];
    if (roomData.status !== 'in_progress') {
      return res.status(400).json({ error: 'Cannot send messages in a closed room.' });
    }

    const [result] = await pool.query(
      `INSERT INTO room_message (room_id, sender_org_id, content, created_at)
       VALUES (?, ?, ?, NOW())`,
      [roomId, orgId, content.trim()]
    );

    // Update room's updated_at
    await pool.query(
      `UPDATE business_room SET updated_at = NOW() WHERE room_id = ?`,
      [roomId]
    );

    // Notify the other org
    const otherOrgId = roomData.org_id_1 === orgId ? roomData.org_id_2 : roomData.org_id_1;
    try {
      await pool.query(
        `INSERT INTO notification (org_id, type, title, message, reference_type, reference_id, created_at)
         VALUES (?, 'new_message', 'New Message',
                 ?, 'business_room', ?, NOW())`,
        [
          otherOrgId,
          `New message in your business room regarding ${roomData.supply_name_snapshot || roomData.demand_name_snapshot || 'a deal'}.`,
          roomId
        ]
      );
    } catch (notifErr) {
      console.error('[Rooms] Message notification error:', notifErr.message);
    }

    res.status(201).json({
      message: 'Message sent.',
      message_id: result.insertId
    });
  } catch (err) {
    console.error('[Rooms] Send message error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// ═══════════════════════════════════════════════════════════════
// PATCH /api/rooms/:id/status — Mark room as success/failed (FR-24, FR-25, FR-26)
// ═══════════════════════════════════════════════════════════════
router.patch('/:id/status', async (req, res) => {
  try {
    const roomId = req.params.id;
    const orgId = req.user.org_id;
    const { status } = req.body; // 'success' or 'failed'

    if (!['success', 'failed'].includes(status)) {
      return res.status(400).json({ error: 'Status must be "success" or "failed".' });
    }

    // Verify membership
    const [room] = await pool.query(
      `SELECT * FROM business_room
       WHERE room_id = ? AND (org_id_1 = ? OR org_id_2 = ?) AND deleted_at IS NULL`,
      [roomId, orgId, orgId]
    );
    if (room.length === 0) {
      return res.status(404).json({ error: 'Room not found.' });
    }

    const roomData = room[0];

    await pool.query(
      `UPDATE business_room SET status = ?, updated_at = NOW() WHERE room_id = ?`,
      [status, roomId]
    );

    let dealId = null;

    // FR-26: On success, create deal + generate QR
    if (status === 'success') {
      const crypto = require('crypto');
      const qrToken = crypto.randomBytes(32).toString('hex');
      const timestamp = new Date().toISOString();

      const qrData = JSON.stringify({
        deal_token: qrToken,
        room_id: roomId,
        supply_org_id: roomData.org_id_1,
        demand_org_id: roomData.org_id_2,
        supply_name: roomData.supply_name_snapshot,
        demand_name: roomData.demand_name_snapshot,
        timestamp: timestamp,
        platform: 'GENYSIS'
      });

      const [dealResult] = await pool.query(
        `INSERT INTO deal
         (room_id, supply_org_id, demand_org_id, supply_id, demand_id,
          supply_name_snapshot, demand_name_snapshot,
          deal_status, qr_code_data, qr_token, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, NOW(), NOW())`,
        [
          roomId,
          roomData.org_id_1,
          roomData.org_id_2,
          roomData.supply_id,
          roomData.demand_id,
          roomData.supply_name_snapshot,
          roomData.demand_name_snapshot,
          qrData,
          qrToken
        ]
      );

      dealId = dealResult.insertId;

      // Notify both orgs about deal success
      const bothOrgs = [roomData.org_id_1, roomData.org_id_2];
      for (const targetOrgId of bothOrgs) {
        try {
          await pool.query(
            `INSERT INTO notification (org_id, type, title, message, reference_type, reference_id, created_at)
             VALUES (?, 'deal_success', 'Deal Finalized!',
                     ?, 'deal', ?, NOW())`,
            [
              targetOrgId,
              `Deal for ${roomData.supply_name_snapshot || roomData.demand_name_snapshot || 'a listing'} has been successfully finalized. ${qrCodePath}`,
              dealResult.insertId
            ]
          );
        } catch (notifErr) {
          console.error('[Rooms] Deal notification error:', notifErr.message);
        }
      }
    }

    res.json({
      message: `Room marked as ${status}.`,
      deal_id: dealId
    });
  } catch (err) {
    console.error('[Rooms] Status update error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// ═══════════════════════════════════════════════════════════════
// DELETE /api/rooms/:id — Soft-delete a room (FR-27)
// ═══════════════════════════════════════════════════════════════
router.delete('/:id', async (req, res) => {
  try {
    const roomId = req.params.id;
    const orgId = req.user.org_id;

    const [result] = await pool.query(
      `UPDATE business_room SET deleted_at = NOW()
       WHERE room_id = ? AND (org_id_1 = ? OR org_id_2 = ?) AND deleted_at IS NULL`,
      [roomId, orgId, orgId]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Room not found.' });
    }

    res.json({ message: 'Business room deleted.' });
  } catch (err) {
    console.error('[Rooms] Delete error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

module.exports = router;
