#!/usr/bin/env ruby
# Adds the FortShare native sources to the app target.
#
# App-local native modules are not autolinked, so the .swift/.mm files have to
# be members of the app target. Doing it in a script (rather than by hand in
# Xcode) keeps the project reproducible from a clean checkout.
require 'xcodeproj'

project_path = File.expand_path('filesharing.xcodeproj', __dir__)
project = Xcodeproj::Project.open(project_path)
target = project.targets.find { |t| t.name == 'filesharing' } or abort 'app target not found'

group = project.main_group['filesharing']['FortShare'] ||
        project.main_group['filesharing'].new_group('FortShare', 'filesharing/FortShare')

sources = Dir[File.join(__dir__, 'filesharing', 'FortShare', '*.{swift,mm,m,h}')].sort
added = []

sources.each do |path|
  name = File.basename(path)
  existing = group.files.find { |f| f.display_name == name }
  ref = existing || group.new_reference(path)

  next unless %w[.swift .mm .m].include?(File.extname(name))
  already = target.source_build_phase.files.any? { |bf| bf.file_ref == ref }
  next if already

  target.source_build_phase.add_file_reference(ref)
  added << name
end

# The .mm shims import "filesharing-Swift.h", which only exists once the target
# has a Swift compilation unit and an Objective-C compatibility header.
target.build_configurations.each do |config|
  config.build_settings['SWIFT_OBJC_INTERFACE_HEADER_NAME'] = 'filesharing-Swift.h'
  config.build_settings['SWIFT_VERSION'] ||= '5.0'
  config.build_settings['CLANG_ENABLE_MODULES'] = 'YES'
  # CLANG_CXX_LANGUAGE_STANDARD is deliberately NOT set here: CocoaPods sets it
  # from React Native's xcconfig, and a target-level override shadows that and
  # breaks the build.
  config.build_settings.delete('CLANG_CXX_LANGUAGE_STANDARD')
end

project.save
puts "target sources: #{target.source_build_phase.files.count}"
puts "added: #{added.empty? ? '(already present)' : added.join(', ')}"

# --- Fonts -------------------------------------------------------------------
# DM Sans (§40) has to be a bundle resource as well as declared in UIAppFonts.
fonts_group = project.main_group['filesharing']['Fonts'] ||
              project.main_group['filesharing'].new_group('Fonts', 'filesharing/Fonts')
font_added = []
Dir[File.join(__dir__, 'filesharing', 'Fonts', '*.ttf')].sort.each do |path|
  name = File.basename(path)
  ref = fonts_group.files.find { |f| f.display_name == name } || fonts_group.new_reference(path)
  next if target.resources_build_phase.files.any? { |bf| bf.file_ref == ref }
  target.resources_build_phase.add_file_reference(ref)
  font_added << name
end
project.save
puts "fonts: #{font_added.empty? ? '(already present)' : font_added.join(', ')}"
