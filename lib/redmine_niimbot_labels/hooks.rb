module RedmineNiimbotLabels
  class Hooks < Redmine::Hook::ViewListener
    # "Print label" in the issue sidebar, under the "Issues" block. On a phone
    # Redmine moves the sidebar into the menu behind the hamburger button.
    # The same sidebar is shown on issue lists too; the partial only renders
    # on the page of a saved issue.
    render_on :view_issues_sidebar_issues_bottom, partial: 'niimbot_labels/sidebar'
  end
end
