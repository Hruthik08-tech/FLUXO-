const express = require('express');
const router = express.Router();
const pool = require('../connections/db');
const { exec } = require('child_process');

// Replace QR code generation logic
const generateQRCode = async (qrData) => {
  return new Promise((resolve, reject) => {
    exec(`python ./barcode/qr_code.py ${qrData}`, (error, stdout, stderr) => {
      if (error) {
        console.error(`Error generating QR code: ${stderr}`);
        return reject(error);
      }
      console.log(`QR Code generated: ${stdout}`);
      resolve(stdout.trim());
    });
  });
};

// ═══════════════════════════════════════════════════════════════
// GET /api/deals — List all deals for the org
// ═══════════════════════════════════════════════════════════════
router.get('/', async (req, res) => {
  try {
    const orgId = req.user.org_id;

    const [rows] = await pool.query(
      `SELECT d.*,
              o_supply.org_name AS supply_org_name,
              o_demand.org_name AS demand_org_name
       FROM deal d
       JOIN organisation o_supply ON o_supply.org_id = d.supply_org_id
       JOIN organisation o_demand ON o_demand.org_id = d.demand_org_id
       WHERE (d.supply_org_id = ? OR d.demand_org_id = ?)
       ORDER BY d.created_at DESC`,
      [orgId, orgId]
    );

    const deals = rows.map(d => ({
      ...d,
      partner_org_name: d.supply_org_id === orgId ? d.demand_org_name : d.supply_org_name,
      partner_org_id: d.supply_org_id === orgId ? d.demand_org_id : d.supply_org_id,
      // Don't expose raw qr_code_data in the list
      qr_code_data: undefined,
      has_qr: !!d.qr_token
    }));

    res.json(deals);
  } catch (err) {
    console.error('[Deals] List error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// ═══════════════════════════════════════════════════════════════
// GET /api/deals/map/partners — Get deal partners with locations
// Used by the default Map view to show the org network
// ═══════════════════════════════════════════════════════════════
router.get('/map/partners', async (req, res) => {
  try {
    const orgId = req.user.org_id;

    // Fetch all deals (active or completed) with partner org locations
    const [rows] = await pool.query(
      `SELECT d.deal_id, d.deal_status,
              d.supply_name_snapshot, d.demand_name_snapshot,
              d.agreed_price, d.quantity, d.currency,
              d.supply_org_id, d.demand_org_id,
              d.created_at,
              o_partner.org_id AS partner_org_id,
              o_partner.org_name AS partner_org_name,
              o_partner.email AS partner_email,
              o_partner.phone_number AS partner_phone,
              o_partner.address AS partner_address,
              o_partner.city AS partner_city,
              o_partner.state AS partner_state,
              o_partner.latitude AS partner_lat,
              o_partner.longitude AS partner_lng,
              o_partner.description AS partner_description,
              o_partner.website_url AS partner_website
       FROM deal d
       JOIN organisation o_partner 
         ON o_partner.org_id = IF(d.supply_org_id = ?, d.demand_org_id, d.supply_org_id)
       WHERE (d.supply_org_id = ? OR d.demand_org_id = ?)
         AND d.deal_status IN ('active', 'completed', 'in_progress', 'pending')
       ORDER BY d.created_at DESC`,
      [orgId, orgId, orgId]
    );

    // Deduplicate by partner org (keep all deals per partner)
    const partnerMap = {};
    for (const row of rows) {
      const pid = row.partner_org_id;
      if (!partnerMap[pid]) {
        partnerMap[pid] = {
          org_id: pid,
          org_name: row.partner_org_name,
          email: row.partner_email,
          phone: row.partner_phone,
          address: row.partner_address,
          city: row.partner_city,
          state: row.partner_state,
          latitude: row.partner_lat,
          longitude: row.partner_lng,
          description: row.partner_description,
          website_url: row.partner_website,
          deals: [],
        };
      }
      partnerMap[pid].deals.push({
        deal_id: row.deal_id,
        deal_status: row.deal_status,
        supply_name: row.supply_name_snapshot,
        demand_name: row.demand_name_snapshot,
        agreed_price: row.agreed_price,
        quantity: row.quantity,
        currency: row.currency,
        created_at: row.created_at,
      });
    }

    res.json({
      total_partners: Object.keys(partnerMap).length,
      partners: Object.values(partnerMap),
    });
  } catch (err) {
    console.error('[Deals] Map partners error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// ═══════════════════════════════════════════════════════════════
// GET /api/deals/:id — Get deal details + QR data (FR-29)
// ═══════════════════════════════════════════════════════════════
router.get('/:id', async (req, res) => {
  try {
    const dealId = req.params.id;
    const orgId = req.user.org_id;

    const [rows] = await pool.query(
      `SELECT d.*,
              o_supply.org_name AS supply_org_name,
              o_demand.org_name AS demand_org_name
       FROM deal d
       JOIN organisation o_supply ON o_supply.org_id = d.supply_org_id
       JOIN organisation o_demand ON o_demand.org_id = d.demand_org_id
       WHERE d.deal_id = ?
         AND (d.supply_org_id = ? OR d.demand_org_id = ?)`,
      [dealId, orgId, orgId]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Deal not found.' });
    }

    const deal = rows[0];
    deal.partner_org_name = deal.supply_org_id === orgId ? deal.demand_org_name : deal.supply_org_name;
    deal.partner_org_id = deal.supply_org_id === orgId ? deal.demand_org_id : deal.supply_org_id;

    res.json(deal);
  } catch (err) {
    console.error('[Deals] Get error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// ═══════════════════════════════════════════════════════════════
// GET /api/deals/verify/:token — Public: Verify a QR code (FR-30)
// ═══════════════════════════════════════════════════════════════
router.get('/verify/:token', async (req, res) => {
  try {
    const token = req.params.token;

    const [rows] = await pool.query(
      `SELECT d.deal_id, d.supply_name_snapshot, d.demand_name_snapshot,
              d.agreed_price, d.quantity, d.currency, d.deal_status,
              d.created_at, d.qr_code_data,
              o_supply.org_name AS supply_org_name,
              o_demand.org_name AS demand_org_name
       FROM deal d
       JOIN organisation o_supply ON o_supply.org_id = d.supply_org_id
       JOIN organisation o_demand ON o_demand.org_id = d.demand_org_id
       WHERE d.qr_token = ?`,
      [token]
    );

    if (rows.length === 0) {
      return res.status(404).json({
        verified: false,
        error: 'Deal not found or QR code is invalid.'
      });
    }

    const deal = rows[0];

    res.json({
      verified: true,
      deal: {
        deal_id: deal.deal_id,
        supply_name: deal.supply_name_snapshot,
        demand_name: deal.demand_name_snapshot,
        supply_org: deal.supply_org_name,
        demand_org: deal.demand_org_name,
        agreed_price: deal.agreed_price,
        quantity: deal.quantity,
        currency: deal.currency,
        status: deal.deal_status,
        created_at: deal.created_at,
        qr_data: JSON.parse(deal.qr_code_data || '{}')
      }
    });
  } catch (err) {
    console.error('[Deals] Verify error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// ═══════════════════════════════════════════════════════════════
// PATCH /api/deals/:id — Update deal (price, quantity, status)
// ═══════════════════════════════════════════════════════════════
router.patch('/:id', async (req, res) => {
  try {
    const dealId = req.params.id;
    const orgId = req.user.org_id;
    const { agreed_price, quantity, deal_status } = req.body;

    // Verify ownership
    const [existing] = await pool.query(
      `SELECT deal_id FROM deal
       WHERE deal_id = ? AND (supply_org_id = ? OR demand_org_id = ?)`,
      [dealId, orgId, orgId]
    );
    if (existing.length === 0) {
      return res.status(404).json({ error: 'Deal not found.' });
    }

    const updates = [];
    const values = [];
    if (agreed_price !== undefined) { updates.push('agreed_price = ?'); values.push(agreed_price); }
    if (quantity !== undefined) { updates.push('quantity = ?'); values.push(quantity); }
    if (deal_status !== undefined) { updates.push('deal_status = ?'); values.push(deal_status); }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No fields to update.' });
    }

    updates.push('updated_at = NOW()');
    values.push(dealId);

    await pool.query(
      `UPDATE deal SET ${updates.join(', ')} WHERE deal_id = ?`,
      values
    );

    res.json({ message: 'Deal updated successfully.' });
  } catch (err) {
    console.error('[Deals] Update error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

module.exports = router;
