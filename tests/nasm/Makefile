source_files := $(wildcard engine/*.asm)
source_files += $(addprefix engine/,$(wildcard *.asm))

obj_files := $(patsubst %.asm,%.o,$(source_files))
host_executables := $(patsubst %.asm,%.bin,$(source_files))
v86_executables := $(patsubst %.asm,%.img,$(source_files))

inc_files := $(addprefix engine/,$(wildcard *.inc))

all: $(source_files) $(obj_files) $(inc_files) $(host_executables) $(v86_executables)
.PHONY: all

engine/%.o: engine/%.asm $(inc_files)
	nasm -w+error -felf32 -o $@ $<

# To run / debug locally
engine/%.bin: engine/%.o
	ld -g $< -m elf_i386 --section-start=.bss=0x100000 --section-start=.text=0x800000 -o $@

# To use as a multiboot kernel image for v86
engine/%.img: engine/%.o
	ld -g $< -m elf_i386 --section-start=.bss=0x100000 --section-start=.text=0x8000 --section-start=.multiboot=0x200 -o $@

engine/%.asm: %.asm
	mkdir -p build; cp $< $@

engine/%.inc: %.inc
	mkdir -p build; cp $< $@

.PHONY: clean
clean:
	rm -f *.o *.bin *.img *.fixture gen_*.asm # old location
	rm -f engine/*.o engine/*.bin engine/*.img engine/*.fixture engine/*.asm
