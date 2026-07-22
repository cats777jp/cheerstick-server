const jwt = require('jsonwebtoken');

const REFERENCE_TOKEN_SECRET = process.env.REFERENCE_TOKEN_SECRET;
const REFERENCE_TOKEN_TTL = '7d';

function generateReferenceToken(deviceId, macAddress) {
  return jwt.sign(
    { device_id: deviceId, mac: macAddress },
    REFERENCE_TOKEN_SECRET,
    { expiresIn: REFERENCE_TOKEN_TTL }
  );
}

function verifyReferenceToken(token) {
  return jwt.verify(token, REFERENCE_TOKEN_SECRET);
}

module.exports = { generateReferenceToken, verifyReferenceToken };
