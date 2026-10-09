# Serves niimbluelib and the plugin's own script as one cacheable file; the
# label data itself is embedded in the issue page (see the sidebar partial).
class NiimbotLabelsController < ApplicationController
  # The script is a static library, nothing secret in it.
  skip_before_action :check_if_login_required, only: :script
  # Rails refuses to serve JavaScript to a plain <script src> GET otherwise.
  skip_after_action :verify_same_origin_request, only: :script, raise: false

  # GET /niimbot_labels/script?v=DIGEST
  def script
    expires_in 1.year, public: true
    render plain: RedmineNiimbotLabels.javascript, content_type: 'text/javascript'
  end
end
