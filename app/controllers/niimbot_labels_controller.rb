class NiimbotLabelsController < ApplicationController
  before_action :require_login, except: :script
  before_action :find_project_by_project_id, :authorize, only: :index

  # The script is a static library, nothing secret in it.
  skip_before_action :check_if_login_required, only: :script
  # Rails refuses to serve JavaScript to a plain <script src> GET otherwise.
  skip_after_action :verify_same_origin_request, only: :script, raise: false

  # GET /projects/:project_id/niimbot_labels?ids=1,2,3 - the print page. Keeps
  # one Bluetooth connection for as many labels as needed. The queue may hold
  # issues of other projects too, as long as labels can be printed there.
  def index
    ids = params[:ids].to_s.scan(/\d+/).map(&:to_i).uniq.first(100)
    issues = Issue.visible.where(id: ids).includes(:project).index_by(&:id)
    printable, @skipped_ids = ids.partition {|id| issues[id] && RedmineNiimbotLabels.printable?(issues[id])}
    @labels = printable.map {|id| RedmineNiimbotLabels.label(issues[id])}
  end

  # GET /niimbot_labels/issues/:id - one label, for "add issue" on the print page.
  def show
    issue = Issue.visible.find_by(id: params[:id])
    if issue.nil?
      render json: {error: l(:error_niimbot_labels_issue_not_found, id: params[:id])}, status: :not_found
    elsif !RedmineNiimbotLabels.printable?(issue)
      render json: {error: l(:error_niimbot_labels_not_allowed, id: issue.id, project: issue.project.name)},
             status: :forbidden
    else
      render json: RedmineNiimbotLabels.label(issue)
    end
  end

  # GET /niimbot_labels/script?v=VERSION
  def script
    expires_in 1.year, public: true
    render plain: RedmineNiimbotLabels.javascript, content_type: 'text/javascript'
  end
end
