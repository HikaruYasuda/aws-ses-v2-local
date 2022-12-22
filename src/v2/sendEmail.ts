import type { RequestHandler } from 'express';
import type { JSONSchema7 } from 'json-schema';
import { AddressObject, simpleParser } from 'mailparser';
import ajv from '../ajv';
import store from '../store';

const handler: RequestHandler = (req, res, next) => {
  const valid = validate(req.body);
  if (!valid) {
    res.status(404).send({ message: 'Bad Request Exception', detail: 'aws-ses-v2-local: Schema validation failed' });
    return;
  }

  if (req.body.Content?.Simple) {
    handleSimple(req, res, next);
  } else if (req.body.Content?.Raw) {
    handleRaw(req, res, next);
  } else if (req.body.Content?.Template) {
    handleTemplate(req, res, next);
  } else {
    res.status(400).send({ message: 'Bad Request Exception', detail: 'aws-ses-v2-local: Must have either Simple or Raw content. Want to add support for other types of emails? Open a PR!' });
  }
};

const handleSimple: RequestHandler = async (req, res) => {
  if (!req.body.Content?.Simple?.Body?.Html?.Data && !req.body.Content?.Simple?.Body?.Text?.Data) {
    res.status(400).send({ message: 'Bad Request Exception', detail: 'aws-ses-v2-local: Simple content must have either a HTML or Text body.' });
    return;
  }

  if (!req.body.Content?.Simple?.Subject?.Data) {
    res.status(400).send({ message: 'Bad Request Exception', detail: 'aws-ses-v2-local: Simple content must have a subject.' });
    return;
  }

  if (!req.body.FromEmailAddress) {
    res.status(400).send({ message: 'Bad Request Exception', detail: 'aws-ses-v2-local: Must have a from email address. Want to add support for other types of emails? Open a PR!' });
    return;
  }

  const messageId = `ses-${Math.floor(Math.random() * 900000000 + 100000000)}`;

  store.emails.push({
    messageId,
    from: req.body.FromEmailAddress,
    replyTo: req.body.ReplyToAddresses ?? [],
    destination: {
      to: req.body.Destination?.ToAddresses ?? [],
      cc: req.body.Destination?.CcAddresses ?? [],
      bcc: req.body.Destination?.BccAddresses ?? [],
    },
    subject: req.body.Content.Simple.Subject.Data,
    body: {
      html: req.body.Content.Simple.Body.Html?.Data,
      text: req.body.Content.Simple.Body.Text?.Data,
    },
    attachments: [],
    at: Math.floor(new Date().getTime() / 1000),
  });

  res.status(200).send({ MessageId: messageId });
};

const handleRaw: RequestHandler = async (req, res) => {
  const messageId = `ses-${Math.floor(Math.random() * 900000000 + 100000000)}`;

  const message = await simpleParser(Buffer.from(req.body.Content?.Raw?.Data, 'base64'));

  store.emails.push({
    messageId,
    from: message.from?.text ?? req.body.Source,
    replyTo: message.replyTo ? [message.replyTo.text] : [],
    destination: {
      to: (Array.isArray(message.to) ? message.to : [message.to || null]).filter((m): m is AddressObject => !!m).map((a) => a.text),
      cc: (Array.isArray(message.cc) ? message.cc : [message.cc || null]).filter((m): m is AddressObject => !!m).map((a) => a.text),
      bcc: (Array.isArray(message.bcc) ? message.bcc : [message.bcc || null]).filter((m): m is AddressObject => !!m).map((a) => a.text),
    },
    subject: message.subject ?? '(no subject)',
    body: {
      text: message.text,
    },
    attachments: message.attachments.map((a) => ({ ...a, content: a.content.toString('base64') })),
    at: Math.floor(new Date().getTime() / 1000),
  });

  res.status(200).send({ MessageId: messageId });
};

const parseTemplateData = (json?: string): {[k:string]: unknown}|false => {
  if (!json) {
    return {};
  }
  try {
    const data = JSON.parse(json);
    if (!data || typeof data !== 'object') {
      return false;
    }
    return data;
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(e);
    return false;
  }
};

const toString = (value: unknown): string => {
  switch (value) {
    case true: return 'true';
    case false: return 'false';
    case null: return '';
    case undefined: return '';
    default: return `${value}`;
  }
};

const compileTemplate = (template: string|undefined, data: {[k:string]: unknown}) => {
  if (!template) {
    return template;
  }
  return Object.entries(data).reduce((prev, [key, value]) => prev.replace(new RegExp(`\\{\\{${key}}}`, 'g'), toString(value)), template);
};

const handleTemplate: RequestHandler = async (req, res) => {
  if (!req.body.Content?.Template?.TemplateName) {
    res.status(400).send({ message: 'Bad Request Exception', detail: 'aws-ses-v2-local: Template content must have a TemplateName.' });
    return;
  }

  if (!req.body.FromEmailAddress) {
    res.status(400).send({ message: 'Bad Request Exception', detail: 'aws-ses-v2-local: Must have a from email address. Want to add support for other types of emails? Open a PR!' });
    return;
  }

  const template = store.templates.get(req.body.Content.Template.TemplateName);
  if (!template) {
    res.status(400).send({ message: 'Bad Request Exception', detail: `aws-ses-v2-local: Template not found for "${req.body.Content.Template.TemplateName}"` });
    return;
  }

  const data = parseTemplateData(req.body.Content.Template.TemplateData);
  if (data === false) {
    res.status(400).send({ message: 'Bad Request Exception', detail: 'aws-ses-v2-local: Invalid template data format.' });
    return;
  }

  const messageId = `ses-${Math.floor(Math.random() * 900000000 + 100000000)}`;

  store.emails.push({
    messageId,
    from: req.body.FromEmailAddress,
    replyTo: req.body.ReplyToAddresses ?? [],
    destination: {
      to: req.body.Destination?.ToAddresses ?? [],
      cc: req.body.Destination?.CcAddresses ?? [],
      bcc: req.body.Destination?.BccAddresses ?? [],
    },
    subject: compileTemplate(template.TemplateContent.Subject, data) || '',
    body: {
      html: compileTemplate(template.TemplateContent.Html, data),
      text: compileTemplate(template.TemplateContent.Text, data),
    },
    attachments: [],
    at: Math.floor(new Date().getTime() / 1000),
  });

  res.status(200).send({ MessageId: messageId });
};

export default handler;

const sendEmailRequestSchema: JSONSchema7 = {
  type: 'object',
  properties: {
    ConfigurationSetName: { type: 'string' },
    Content: {
      type: 'object',
      properties: {
        Raw: {
          type: 'object',
          properties: {
            Data: { type: 'string' }, // base-64 encoded blob
          },
        },
        Simple: {
          type: 'object',
          properties: {
            Body: {
              type: 'object',
              properties: {
                Html: {
                  type: 'object',
                  properties: {
                    Charset: { type: 'string' },
                    Data: { type: 'string' },
                  },
                  required: ['Data'],
                },
                Text: {
                  type: 'object',
                  properties: {
                    Charset: { type: 'string' },
                    Data: { type: 'string' },
                  },
                  required: ['Data'],
                },
              },
            },
            Subject: {
              type: 'object',
              properties: {
                Charset: { type: 'string' },
                Data: { type: 'string' },
              },
              required: ['Data'],
            },
          },
          required: ['Body', 'Subject'],
        },
        Template: {
          type: 'object',
          properties: {
            TemplateArn: { type: 'string' },
            TemplateData: { type: 'string' },
            TemplateName: { type: 'string' },
          },
        },
      },
    },
    Destination: {
      type: 'object',
      properties: {
        BccAddresses: { type: 'array', items: { type: 'string' } },
        CcAddresses: { type: 'array', items: { type: 'string' } },
        ToAddresses: { type: 'array', items: { type: 'string' } },
      },
    },
    EmailTags: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          Name: { type: 'string' },
          Value: { type: 'string' },
        },
      },
    },
    FeedbackForwardingEmailAddress: { type: 'string' },
    FeedbackForwardingEmailAddressIdentityArn: { type: 'string' },
    FromEmailAddress: { type: 'string' },
    FromEmailAddressIdentityArn: { type: 'string' },
    ListManagementOptions: {
      type: 'object',
      properties: {
        ContactListName: { type: 'string' },
        TopicName: { type: 'string' },
      },
    },
    ReplyToAddresses: { type: 'array', items: { type: 'string' } },
  },
  required: ['Content'],
};

const validate = ajv.compile(sendEmailRequestSchema);
