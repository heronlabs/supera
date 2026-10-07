.PHONY: test lint

test:
	bats tests/

lint:
	shellcheck $(wildcard scripts/*.sh skills/*/scripts/*.sh hooks/*.sh) tests/*.bats tests/*.bash
	jq empty schema/*.json $(wildcard hooks/*.json)
	ruby -ryaml -e 'ARGV.each { |f| fm = File.read(f)[/\A---\n(.*?\n)---\n/m, 1] or abort("#{f}: no YAML frontmatter"); YAML.safe_load(fm, filename: f).is_a?(Hash) or abort("#{f}: frontmatter is not a mapping") }' \
		skills/*/SKILL.md agents/*.md
