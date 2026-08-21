const axios = require('axios');

exports.main = async (event, callback) => {
  const TOKEN = process.env.HUBSPOT_ACCESS_TOKEN;

  const PHONE_PROPERTY = 'phone';
  const DUPLICATE_RISK_PROPERTY = 'duplicate_risk';

  const DUPLICATE_RISK_YES = 'true';
  const DUPLICATE_RISK_NO = 'false';

  // --- Limites de classificação de telefone ---
  // Faixa válida de dígitos para um número internacional
  // (E.164 permite até 15 dígitos).
  const MIN_INTL_DIGITS = 8;
  const MAX_INTL_DIGITS = 15;

  // A partir desse tamanho, um número sem "+" ou "00"
  // é assumido como internacional (inferência por tamanho).
  const MIN_INFERRED_INTL_DIGITS = 12;

  // Tamanho mínimo para considerar que um "0" inicial
  // é um zero de trunk (prefixo de discagem local) e não
  // parte do número em si.
  const MIN_TRUNK_ZERO_STRIP_LENGTH = 9;

  // Abaixo disso, o número local é curto demais para
  // ser usado com confiança na deduplicação.
  const MIN_LOCAL_DIGITS = 8;

  // Tamanho mínimo de um telefone local para permitir
  // correlação por sufixo com números internacionais.
  const MIN_LOCAL_SUFFIX_MATCH_LENGTH = 10;

  if (!TOKEN) {
    throw new Error('Secret HUBSPOT_ACCESS_TOKEN não encontrado.');
  }

  const api = axios.create({
    baseURL: 'https://api.hubapi.com',
    timeout: 10000,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json'
    }
  });

  // Limpa o telefone e retorna os dados necessários
  // para sua posterior classificação.
  function cleanPhone(value) {
    if (value === null || value === undefined) {
      return null;
    }

    let phone = String(value).trim();

    if (!phone) {
      return null;
    }

    // Remove ramais no final do telefone.
    phone = phone.replace(
      /\s*(?:ramal|ext\.?|extension|x)\s*\d+\s*$/i,
      ''
    );

    const startsWithPlus = phone.startsWith('+');
    const digits = phone.replace(/\D/g, '');

    if (!digits) {
      return null;
    }

    return {
      digits,
      startsWithPlus
    };
  }

  // Monta o resultado de um número internacional válido,
  // ou null caso o tamanho esteja fora da faixa aceita.
  function toInternationalResult(digits, confidence) {
    if (
      digits.length >= MIN_INTL_DIGITS &&
      digits.length <= MAX_INTL_DIGITS
    ) {
      return {
        type: 'international',
        value: digits,
        confidence
      };
    }

    return null;
  }

  // Classifica o telefone como internacional ou local.
  //
  // Internacional explícito (+ ou 00):
  // confidence = high
  //
  // Internacional inferido pelo tamanho:
  // confidence = inferred
  //
  // Local com 8–9 dígitos:
  // confidence = low
  //
  // Local com 10–11 dígitos:
  // confidence = high
  function classifyPhone(cleanedPhone) {
    if (!cleanedPhone) {
      return null;
    }

    let { digits, startsWithPlus } = cleanedPhone;

    // Ex.: 00442079460958 → 442079460958
    if (digits.startsWith('00')) {
      return toInternationalResult(digits.slice(2), 'high');
    }

    // Ex.: +44 20 7946 0958
    if (startsWithPlus) {
      return toInternationalResult(digits, 'high');
    }

    // Ex.: 5511999999999 ou 442079460958.
    // Sem "+" ou "00", portanto a classificação é inferida.
    if (
      digits.length >= MIN_INFERRED_INTL_DIGITS &&
      digits.length <= MAX_INTL_DIGITS &&
      !digits.startsWith('0')
    ) {
      return toInternationalResult(digits, 'inferred');
    }

    // Remove zero de trunk de números locais.
    // Ex.: 02079460958 → 2079460958
    if (
      digits.startsWith('0') &&
      digits.length >= MIN_TRUNK_ZERO_STRIP_LENGTH
    ) {
      digits = digits.slice(1);
    }

    // Menos que o mínimo não é utilizado na deduplicação.
    if (digits.length < MIN_LOCAL_DIGITS) {
      return null;
    }

    return {
      type: 'local',
      value: digits,
      confidence:
        digits.length < MIN_LOCAL_SUFFIX_MATCH_LENGTH
          ? 'low'
          : 'high'
    };
  }

  function parsePhone(value) {
    return classifyPhone(cleanPhone(value));
  }

  async function getAllContacts() {
    const contacts = [];
    let after;

    do {
      const params = {
        limit: 100,
        properties: `${PHONE_PROPERTY},${DUPLICATE_RISK_PROPERTY}`,
        archived: false
      };

      if (after) {
        params.after = after;
      }

      const response = await api.get(
        '/crm/v3/objects/contacts',
        { params }
      );

      const results = response.data.results || [];

      for (const contact of results) {
        contacts.push({
          id: String(contact.id),
          phone:
            contact.properties?.[PHONE_PROPERTY] ||
            null,
          duplicateRisk:
            contact.properties?.[DUPLICATE_RISK_PROPERTY] ||
            null
        });
      }

      after =
        response.data.paging?.next?.after ||
        null;

    } while (after);

    return contacts;
  }

  async function batchUpdateContacts(updates) {
    const batchSize = 100;

    for (
      let i = 0;
      i < updates.length;
      i += batchSize
    ) {
      const batch = updates.slice(
        i,
        i + batchSize
      );

      await api.post(
        '/crm/v3/objects/contacts/batch/update',
        {
          inputs: batch
        }
      );
    }
  }

  try {
    // 1. Busca todos os contatos.
    const contacts = await getAllContacts();

    // 2. Analisa telefones e mapeia números internacionais.
    const internationalNumbers = new Set();

    for (const contact of contacts) {
      const parsedPhone = parsePhone(
        contact.phone
      );

      contact.parsedPhone = parsedPhone;

      if (
        parsedPhone?.type ===
        'international'
      ) {
        internationalNumbers.add(
          parsedPhone.value
        );
      }
    }

    // 3. Resolve telefones locais contra internacionais conhecidos.
    for (const contact of contacts) {
      const parsed = contact.parsedPhone;

      if (!parsed) {
        contact.normalizedPhone = null;
        continue;
      }

      if (parsed.type === 'international') {
        contact.normalizedPhone =
          parsed.value;

        continue;
      }

      // Telefones locais curtos são válidos,
      // mas não possuem contexto suficiente para
      // correlação segura com números internacionais.
      //
      // Ex.: 12345678 não deve ser associado a:
      // +81 3 1234 5678
      // +49 30 12345678
      if (
        parsed.value.length <
        MIN_LOCAL_SUFFIX_MATCH_LENGTH
      ) {
        contact.normalizedPhone =
          `LOCAL:${parsed.value}`;

        continue;
      }

      const matches = [];

      for (
        const international
        of internationalNumbers
      ) {
        if (
          international.endsWith(
            parsed.value
          )
        ) {
          matches.push(
            international
          );
        }
      }

      // Só associa local → internacional
      // quando existe exatamente um candidato.
      if (matches.length === 1) {
        contact.normalizedPhone =
          matches[0];
      } else {
        contact.normalizedPhone =
          `LOCAL:${parsed.value}`;
      }
    }

    // 4. Agrupa contatos pelo telefone normalizado.
    const groups = new Map();

    for (const contact of contacts) {
      const normalizedPhone =
        contact.normalizedPhone;

      if (!normalizedPhone) {
        continue;
      }

      if (!groups.has(normalizedPhone)) {
        groups.set(
          normalizedPhone,
          []
        );
      }

      groups
        .get(normalizedPhone)
        .push(contact.id);
    }

    // 5. Identifica grupos com mais de um contato.
    const duplicateIds = new Set();
    let duplicateGroups = 0;

    for (const ids of groups.values()) {
      if (ids.length <= 1) {
        continue;
      }

      duplicateGroups++;

      for (const id of ids) {
        duplicateIds.add(id);
      }
    }

    // 6. Prepara apenas registros cujo valor precisa mudar.
    const updates = [];

    for (const contact of contacts) {
      const isDuplicate =
        duplicateIds.has(contact.id);

      const desiredValue =
        isDuplicate
          ? DUPLICATE_RISK_YES
          : DUPLICATE_RISK_NO;

      if (
        String(
          contact.duplicateRisk || ''
        ) === desiredValue
      ) {
        continue;
      }

      updates.push({
        id: contact.id,
        properties: {
          [DUPLICATE_RISK_PROPERTY]:
            desiredValue
        }
      });
    }

    // 7. Atualiza o HubSpot.
    await batchUpdateContacts(updates);

    callback({
      outputFields: {
        contacts_scanned:
          contacts.length,
        duplicate_groups:
          duplicateGroups,
        duplicate_contacts:
          duplicateIds.size,
        contacts_updated:
          updates.length
      }
    });

  } catch (error) {
    const status =
      error.response?.status;

    // Preserva erros transitórios para permitir retry.
    if (
      status === 429 ||
      status >= 500
    ) {
      throw error;
    }

    const detail =
      error.response?.data
        ?.errors?.[0]?.message ??
      error.response?.data?.message ??
      error.message ??
      'Erro desconhecido';

    throw new Error(
      `HubSpot API ${
        status ?? 'SEM_STATUS'
      }: ${String(detail).slice(0, 400)}`,
      { cause: error }
    );
  }
};
