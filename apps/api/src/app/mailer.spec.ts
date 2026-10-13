import { vi } from 'vitest';

const transportSendMail = vi.hoisted(() => vi.fn());

vi.mock('nodemailer', () => ({
  default: {
    createTransport: () => ({ sendMail: transportSendMail }),
  },
}));

describe('mailer', () => {
  const smtpHost = process.env['SMTP_HOST'];
  let mailer: typeof import('./mailer.js');

  beforeAll(async () => {
    // the setup file already loaded the mailer with the real transport
    vi.resetModules();
    mailer = await import('./mailer.js');
  });

  beforeEach(() => {
    process.env['SMTP_HOST'] = 'smtp.test';
    transportSendMail.mockReset();
    transportSendMail.mockResolvedValue({});
  });

  afterEach(() => {
    process.env['SMTP_HOST'] = smtpHost;
  });

  it('escapes html', () => {
    expect(mailer.escapeHtml('<a href="x">\'&\'</a>')).toEqual(
      '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;',
    );
  });

  it('escapes interpolated values in the mention email', async () => {
    const sent = await mailer.sendMentionNotificationEmail(
      'to@test.dev',
      'board"id',
      '<script>alert(1)</script>',
      '<img src=x onerror=alert(1)>',
      'node&id=<x>',
    );

    expect(sent).toEqual(true);

    const { html } = transportSendMail.mock.calls[0][0];

    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain(
      `/board/${encodeURIComponent('board"id')}?nodeId=${encodeURIComponent('node&id=<x>')}`,
    );
  });

  it('escapes interpolated values in the invitation email', async () => {
    await mailer.sendInvitationEmail(
      'to@test.dev',
      '<b>team</b>',
      '<i>inviter</i>',
    );

    const { html } = transportSendMail.mock.calls[0][0];

    expect(html).toContain('&lt;i&gt;inviter&lt;/i&gt;');
    expect(html).toContain('&lt;b&gt;team&lt;/b&gt;');
  });

  it('never throws when the transport fails', async () => {
    transportSendMail.mockRejectedValue(new Error('smtp down'));
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);

    await expect(
      mailer.sendMail('to@test.dev', 'subject', 'html'),
    ).resolves.toEqual(false);

    consoleError.mockRestore();
  });

  it('sends from SMTP_USER when SMTP_FROM is empty', async () => {
    vi.stubEnv('SMTP_FROM', '');
    vi.stubEnv('SMTP_USER', 'user@test.dev');

    try {
      await mailer.sendMail('to@test.dev', 'subject', 'html');
    } finally {
      vi.unstubAllEnvs();
    }

    expect(transportSendMail.mock.calls[0][0].from).toEqual('user@test.dev');
  });

  it('returns false without SMTP', async () => {
    delete process.env['SMTP_HOST'];

    await expect(
      mailer.sendMail('to@test.dev', 'subject', 'html'),
    ).resolves.toEqual(false);
    expect(transportSendMail).not.toHaveBeenCalled();
  });
});
