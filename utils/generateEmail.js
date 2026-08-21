const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

function randomLength() {
  return Math.floor(Math.random() * 5) + 8;
}

function generateLocalPart() {
  const length = randomLength();
  let result = "";

  for (let i = 0; i < length; i += 1) {
    const index = Math.floor(Math.random() * ALPHABET.length);
    result += ALPHABET[index];
  }

  return result;
}

function buildAddress(localPart, domain) {
  return `${localPart}@${domain}`.toLowerCase();
}

module.exports = {
  buildAddress,
  generateLocalPart
};
