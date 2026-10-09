module RedmineNiimbotLabels
  VERSION = '0.3.0'.freeze

  # Matches the 50x30 mm labels sold for the B1.
  DEFAULT_SETTINGS = {
    'width_mm' => '50',
    'height_mm' => '30',
    'density' => '3',
    'show_subject' => '1'
  }.freeze

  PRINTER_ICON = <<~SVG.squish.html_safe
    <svg class="s18 icon-svg" aria-hidden="true" viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round">
      <path d="M17 17h2a2 2 0 0 0 2 -2v-4a2 2 0 0 0 -2 -2h-14a2 2 0 0 0 -2 2v4a2 2 0 0 0 2 2h2"/>
      <path d="M17 9v-4a2 2 0 0 0 -2 -2h-6a2 2 0 0 0 -2 2v4"/>
      <path d="M7 15a2 2 0 0 1 2 -2h6a2 2 0 0 1 2 2v4a2 2 0 0 1 -2 2h-6a2 2 0 0 1 -2 -2z"/>
    </svg>
  SVG

  # Whether the current user may print the label of this issue: the issue's
  # project has the module enabled and one of the user's roles there has
  # :print_issue_labels. Admins pass whenever the module is enabled.
  def self.printable?(issue, user = User.current)
    user.logged? && user.allowed_to?(:print_issue_labels, issue.project)
  end

  # Everything the browser needs to draw and print the label of one issue.
  # The QR matrix is computed here (rqrcode ships with Redmine for 2FA), so
  # the page needs no QR library and every module lands on whole printer dots.
  def self.label(issue)
    url = issue_url(issue)
    {id: issue.id, subject: issue.subject, url: url, qr: qr_rows(url)}
  end

  # Built from Administration > Settings > General (protocol and host name),
  # like the links in Redmine's own emails, so that a label printed from a
  # phone on the internal network points at the same address as one printed
  # from a desktop.
  def self.issue_url(issue)
    "#{base_url}/issues/#{issue.id}"
  end

  def self.base_url
    host = Setting.host_name.to_s.strip.sub(%r{\Ahttps?://}i, '').chomp('/')
    "#{Setting.protocol}://#{host}"
  end

  # Host the QR codes point to, when it is not the host the page was opened
  # from - most likely Host name was never set and is still localhost:3000.
  def self.host_mismatch(request)
    host = URI.parse(base_url).host
    host == request.host ? nil : host
  rescue URI::Error
    Setting.host_name
  end

  # Rows of '0'/'1', one character per module.
  def self.qr_rows(text)
    RQRCode::QRCode.new(text, level: :m).modules.map {|row| row.map {|dark| dark ? '1' : '0'}.join}
  end

  # Settings as numbers, with anything out of range replaced by the default.
  def self.settings
    raw = Setting.plugin_redmine_niimbot_labels || {}
    {
      width_mm: number(raw['width_mm'], 10..100, 50),
      height_mm: number(raw['height_mm'], 10..100, 30),
      density: number(raw['density'], 1..5, 3),
      show_subject: raw.fetch('show_subject', '1').to_s == '1'
    }
  end

  def self.number(value, range, default)
    n = Integer(value.to_s, exception: false)
    n && range.cover?(n) ? n : default
  end

  # niimbluelib (vendored UMD build) followed by this plugin's own code,
  # served as one script by NiimbotLabelsController#script. Going through a
  # controller instead of the plugin asset pipeline keeps it working where
  # `assets:precompile` was never run, and lets browsers cache it.
  def self.javascript
    @javascript ||= %w(niimbluelib.min.js niimbot_labels.js).map do |name|
      File.read(File.join(__dir__, '..', 'assets', 'javascripts', name))
    end.join(";\n")
  end

  # Cache buster for the script URL.
  def self.javascript_digest
    @javascript_digest ||= Digest::SHA256.hexdigest(javascript)[0, 12]
  end

  JS_STRINGS = %w(
    connecting printing printed error unsupported disconnected connected battery lid_open no_paper
  ).freeze

  # Settings and translations for niimbot_labels.js, as one JSON-able hash.
  def self.client_config
    {
      settings: settings,
      strings: JS_STRINGS.to_h {|key| [key, ::I18n.t("niimbot_labels_js.#{key}")]}
    }
  end
end

require_relative 'redmine_niimbot_labels/hooks'
