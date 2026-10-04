# Held revision

This directory is held at an earlier revision of the broker than the one the
maintainers run internally. That is deliberate, and it is the only difference
that matters when you compare the two trees.

The newer revision has a test suite that includes a tripwire against a
permission registry kept in a private repository. The suite cannot run without
that file, and the broker code and its tests are coupled: taking the new broker
without the new tests (or the reverse) fails. Publishing the registry would
expose internal project identifiers, and replacing it with a fixture would make
the tripwire guard a registry that does not exist. Neither is acceptable.

So the public tree keeps the previous broker and its own suite, and the
tripwire keeps running against the real registry in the private repository's CI.

What changes this: a decoupled version of the newer broker whose tests read the
registry through an injectable path, so a public fixture can stand in for it
without weakening the private check. Until that exists, do not sync the newer
broker files into this directory by hand.
