module RedmineNiimbotLabels
  class Hooks < Redmine::Hook::ViewListener
    # Print button with a preview, under the issue attributes.
    render_on :view_issues_show_details_bottom, partial: 'niimbot_labels/issue_button'

    # "Print labels" for the issues selected in a list.
    render_on :view_issues_context_menu_end, partial: 'niimbot_labels/context_menu'
  end
end
